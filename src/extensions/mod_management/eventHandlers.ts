import {IExtensionApi} from '../../types/IExtensionContext';
import {IState} from '../../types/IState';
import { ProcessCanceled, TemporaryError, UserCanceled } from '../../util/CustomErrors';
import * as fs from '../../util/fs';
import {showError} from '../../util/message';
import {getSafe} from '../../util/storeHelper';
import {truthy} from '../../util/util';

import {IDownload} from '../download_management/types/IDownload';
import {activeGameId} from '../profile_management/selectors';
import {addMod, removeMod} from './actions/mods';
import {setActivator} from './actions/settings';
import {IDeploymentMethod} from './types/IDeploymentMethod';
import {IMod} from './types/IMod';
import {loadActivation, saveActivation} from './util/activationStore';

import {getGame} from '../gamemode_management/index';
import {setModEnabled} from '../profile_management/actions/profiles';
import {IProfile} from '../profile_management/types/IProfile';

import allTypesSupported from './util/allTypesSupported';
import refreshMods from './util/refreshMods';
import supportedActivators from './util/supportedActivators';

import InstallManager from './InstallManager';
import {currentActivator, installPath, installPathForGame} from './selectors';

import * as Promise from 'bluebird';
import * as path from 'path';
import getNormalizeFunc, { Normalize } from '../../util/getNormalizeFunc';
import queryGameId from './util/queryGameId';
import { downloadPathForGame, currentGame } from '../../util/selectors';

export function onGameModeActivated(
    api: IExtensionApi, activators: IDeploymentMethod[], newGame: string) {
  const store = api.store;
  const state: IState = store.getState();
  const configuredActivatorId = currentActivator(state);
  const supported = supportedActivators(activators, state);
  const configuredActivator =
    supported.find(activator => activator.id === configuredActivatorId);
  const gameId = activeGameId(state);
  const gameDiscovery = state.settings.gameMode.discovered[gameId];
  const game = getGame(gameId);

  if ((gameDiscovery === undefined)
      || (gameDiscovery.path === undefined)
      || (game === undefined)) {
    return;
  }

  const instPath = installPath(state);

  if (configuredActivator === undefined) {
    // current activator is not valid for this game. This should only occur
    // if compatibility of the activator has changed

    const oldActivator = activators.find(iter => iter.id === configuredActivatorId);

    if ((configuredActivatorId !== undefined) && (oldActivator === undefined)) {
      api.showErrorNotification(
        'Deployment method no longer available',
        {
          reason:
          'The deployment method used with this game is no longer available. ' +
          'This probably means you removed the corresponding extension or ' +
          'it can no longer be loaded due to a bug.\n' +
          'Vortex can\'t clean up files deployed with an unsupported method. ' +
          'You should try to restore it, purge deployment and then switch ' +
          'to a different method.',
          method: configuredActivatorId,
        }, { allowReport: false });
    } else {
      const modPaths = game.getModPaths(gameDiscovery.path);
      const purgePromise = oldActivator !== undefined
        ? Promise.mapSeries(Object.keys(modPaths),
            typeId => oldActivator.purge(instPath, modPaths[typeId]))
              .then(() => undefined)
              .catch(TemporaryError, err =>
                  api.showErrorNotification('Purge failed, please try again',
                    err.message, { allowReport: false }))
              .catch(err => api.showErrorNotification('Purge filed', err))
        : Promise.resolve();

      purgePromise.then(() => {
        if (supported.length > 0) {
          api.store.dispatch(
            setActivator(newGame, supported[0].id));
        }
      });
    }
  }

  const knownMods: { [modId: string]: IMod } = getSafe(state, ['persistent', 'mods', newGame], {});
  refreshMods(instPath, Object.keys(knownMods), (mod: IMod) => {
    api.store.dispatch(addMod(newGame, mod));
  }, (modNames: string[]) => {
    modNames.forEach((name: string) => {
      if (['downloaded', 'installed'].indexOf(knownMods[name].state) !== -1) {
        api.store.dispatch(removeMod(newGame, name));
      }
    });
  })
    .then(() => {
      api.events.emit('mods-refreshed');
      return null;
    })
    .catch(UserCanceled, () => undefined)
    .catch((err: Error) => {
      showError(store.dispatch, 'Failed to refresh mods', err,
                { allowReport: (err as any).code !== 'ENOENT' });
    });
}

export function onPathsChanged(api: IExtensionApi,
                               previous: { [gameId: string]: string },
                               current: { [gameId: string]: string }) {
  const store = api.store;
  const state = store.getState();
  const gameMode = activeGameId(state);
  if (previous[gameMode] !== current[gameMode]) {
    const knownMods = state.persistent.mods[gameMode];
    refreshMods(installPath(state), Object.keys(knownMods || {}), (mod: IMod) =>
      api.store.dispatch(addMod(gameMode, mod))
      , (modNames: string[]) => {
        modNames.forEach((name: string) => {
          if (['downloaded', 'installed'].indexOf(knownMods[name].state) !== -1) {
            api.store.dispatch(removeMod(gameMode, name));
          }
        });
      })
      .then(() => null)
      .catch((err: Error) => {
        showError(store.dispatch, 'Failed to refresh mods', err);
      });
  }
}

function undeploy(api: IExtensionApi,
                  activators: IDeploymentMethod[],
                  gameMode: string,
                  mod: IMod): Promise<void> {
  const store = api.store;
  const state: IState = store.getState();

  const discovery = state.settings.gameMode.discovered[gameMode];

  if ((discovery === undefined) || (discovery.path === undefined)) {
    // if the game hasn't been discovered we can't deploy, but that's not really a problem
    return Promise.resolve();
  }

  const game = getGame(gameMode);
  const modPaths = game.getModPaths(discovery.path);
  const modTypes = Object.keys(modPaths);

  const activatorId = getSafe(state, ['settings', 'mods', 'activator', gameMode], undefined);
  // TODO: can only use one activator that needs to support the whole game
  const activator: IDeploymentMethod = activatorId !== undefined
    ? activators.find(act => act.id === activatorId)
    : activators.find(act => allTypesSupported(act, state, gameMode, modTypes) === undefined);

  if (activator === undefined) {
    return Promise.reject(new ProcessCanceled('No deployment method active'));
  }

  const installationPath = installPathForGame(state, gameMode);

  const dataPath = modPaths[mod.type || ''];
  let normalize: Normalize;
  return getNormalizeFunc(dataPath)
    .then(norm => {
      normalize = norm;
      return loadActivation(api, mod.type, dataPath);
    })
    .then(lastActivation => activator.prepare(dataPath, false, lastActivation, normalize))
    .then(() => (mod !== undefined)
      ? activator.deactivate(installationPath, dataPath, mod)
      : Promise.resolve())
    .then(() => activator.finalize(gameMode, dataPath, installationPath))
    .then(newActivation => saveActivation(mod.type, state.app.instanceId, dataPath, newActivation));
}

export function onRemoveMod(api: IExtensionApi,
                            activators: IDeploymentMethod[],
                            gameMode: string,
                            modId: string,
                            callback?: (error: Error) => void) {
  const store = api.store;
  const state: IState = store.getState();

  const modState = getSafe(state, ['persistent', 'mods', gameMode, modId, 'state'], undefined);
  if (['downloaded', 'installed'].indexOf(modState) === -1) {
    if (callback !== undefined) {
      callback(new ProcessCanceled('Can\'t delete mod during download or install'));
    }
    return;
  }

  // we need to remove the mod from activation, otherwise me might leave orphaned
  // links in the mod directory
  let profileId: string;
  const lastActive = getSafe(state,
    ['settings', 'profiles', 'lastActiveProfile', gameMode], undefined);
  if (lastActive !== undefined) {
    profileId = (typeof(lastActive) === 'string')
      ? lastActive
      : lastActive.profileId;
  }

  const profile: IProfile = getSafe(state, ['persistent', 'profiles', profileId], undefined);
  const wasEnabled: boolean = getSafe(profile, ['modState', modId, 'enabled'], false);

  store.dispatch(setModEnabled(profileId, modId, false));

  const installationPath = installPathForGame(state, gameMode);

  let mod: IMod;

  try {
    const mods = state.persistent.mods[gameMode];
    mod = mods[modId];
  } catch (err) {
    if (callback !== undefined) {
      callback(err);
    } else {
      api.showErrorNotification('Failed to remove mod', err);
    }
    return;
  }

  if (mod === undefined) {
    if (callback !== undefined) {
      callback(null);
    }
    return;
  }

  // TODO: no indication anything is happening until undeployment was successful.
  //   we used to remove the mod right away but then if undeployment failed the mod was gone
  //   anyway

  (wasEnabled ? undeploy(api, activators, gameMode, mod) : Promise.resolve())
  .then(() => truthy(mod)
    ? fs.removeAsync(path.join(installationPath, mod.installationPath))
        .catch(err => err.code === 'ENOENT' ? Promise.resolve() : Promise.reject(err))
    : Promise.resolve())
  .then(() => {
    store.dispatch(removeMod(gameMode, mod.id));
    if (callback !== undefined) {
      callback(null);
    }
  })
  .catch(TemporaryError, (err) => {
    if (callback !== undefined) {
      callback(err);
    } else {
      api.showErrorNotification('Failed to undeploy mod, please try again',
        err.message, { allowReport: false });
    }
  })
  .catch(ProcessCanceled, (err) => {
    if (callback !== undefined) {
      callback(err);
    } else {
      api.showErrorNotification('Failed to remove mod', err.message, { allowReport: false });
    }
  })
  .catch(err => {
    if (callback !== undefined) {
      callback(err);
    } else {
      api.showErrorNotification('Failed to remove mod', err);
    }
  });
}

export function onAddMod(api: IExtensionApi, gameId: string,
                         mod: IMod, callback: (err: Error) => void) {
  const store = api.store;
  const state: IState = store.getState();

  const installationPath = installPathForGame(state, gameId);

  store.dispatch(addMod(gameId, mod));
  fs.ensureDirAsync(path.join(installationPath, mod.installationPath))
  .then(() => {
    callback(null);
  })
  .catch(err => {
    callback(err);
  });
}

export function onStartInstallDownload(api: IExtensionApi,
                                       installManager: InstallManager,
                                       downloadId: string,
                                       callback?: (error, id: string) => void): Promise<void> {
  const store = api.store;
  const state: IState = store.getState();
  const download: IDownload = state.persistent.downloads.files[downloadId];
  if (download === undefined) {
    api.showErrorNotification('Unknown Download',
      'Sorry, I was unable to identify the archive this mod was installed from. '
      + 'Please reinstall by installing the file from the downloads tab.', {
        allowReport: false,
      });
    return Promise.resolve();
  }

  return queryGameId(api.store, download.game)
    .then(gameId => {
      if (!truthy(download.localPath)) {
        api.events.emit('refresh-downloads',  gameId, () => {
          api.showErrorNotification('Download invalid',
            'Sorry, the meta data for this download is incomplete. Vortex has '
            + 'tried to refresh it, please try again.',
            { allowReport: false });
        });
        return Promise.resolve();
      }

      const downloadGame: string = Array.isArray(download.game) ? download.game[0] : download.game;
      const downloadPath: string = downloadPathForGame(state, downloadGame);
      if (downloadPath === undefined) {
        api.showErrorNotification('Unknown Game',
          'Failed to determine installation directory. This shouldn\'t have happened', {
            allowReport: true,
          });
        return;
      }
      const fullPath: string = path.join(downloadPath, download.localPath);

      // Check if we need to convert the gameid.
      //  this is used when two separate game id's are mapped against
      //  the same nexus page id. (Currently only NWN: OE and NWN: EE)
      let forcedId = undefined;
      const activeGame = currentGame(state);
      if (activeGame !== undefined 
        && activeGame.details !== undefined 
        && activeGame.details.nexusPageId !== undefined) {
          forcedId = activeGame.id;
        }

      installManager.install(downloadId, fullPath, download.game, api,
        { download }, true, false, callback, forcedId !== undefined ? forcedId : gameId);
    })
    .catch(err => {
      if (callback !== undefined) {
        callback(err, undefined);
      } else if (!(err instanceof UserCanceled)) {
        api.showErrorNotification('Failed to start download', err);
      }
    });
}
