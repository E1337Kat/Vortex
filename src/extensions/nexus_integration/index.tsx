import { setDownloadModInfo } from '../../actions';
import { IDialogResult, showDialog } from '../../actions/notifications';
import InputButton from '../../controls/InputButton';
import { IExtensionApi, IExtensionContext, ILookupResult } from '../../types/IExtensionContext';
import { IState } from '../../types/IState';
import { ProcessCanceled, DataInvalid } from '../../util/CustomErrors';
import { setApiKey } from '../../util/errorHandling';
import LazyComponent from '../../util/LazyComponent';
import { log } from '../../util/log';
import { showError } from '../../util/message';
import opn from '../../util/opn';
import { activeGameId, gameById, downloadPathForGame } from '../../util/selectors';
import { currentGame, getSafe } from '../../util/storeHelper';
import { decodeHTML, truthy } from '../../util/util';

import { ICategoryDictionary } from '../category_management/types/ICategoryDictionary';
import { DownloadIsHTML } from '../download_management/DownloadManager';
import { IGameStored } from '../gamemode_management/types/IGameStored';
import { setUpdatingMods } from '../mod_management/actions/session';
import { IMod } from '../mod_management/types/IMod';

import { setUserAPIKey } from './actions/account';
import { setNewestVersion, setUserInfo } from './actions/persistent';
import { setAssociatedWithNXMURLs } from './actions/settings';
import { accountReducer } from './reducers/account';
import { persistentReducer } from './reducers/persistent';
import { settingsReducer } from './reducers/settings';
import { nexusGameId } from './util/convertGameId';
import retrieveCategoryList from './util/retrieveCategories';
import DashboardBanner from './views/DashboardBanner';
import GoPremiumDashlet from './views/GoPremiumDashlet';
import LoginDialog from './views/LoginDialog';
import LoginIcon from './views/LoginIcon';
import { } from './views/Settings';

import { genEndorsedAttribute, genGameAttribute, genModIdAttribute } from './attributes';
import * as eh from './eventHandlers';
import * as sel from './selectors';
import { processErrorMessage, startDownload, validateKey, retrieveNexusGames, nexusGames, endorseModImpl } from './util';

import * as Promise from 'bluebird';
import { remote } from 'electron';
import * as fuzz from 'fuzzball';
import * as I18next from 'i18next';
import NexusT from 'nexus-api';
import * as path from 'path';
import * as React from 'react';
import { Button } from 'react-bootstrap';
import {} from 'uuid';
import * as WebSocket from 'ws';
import NXMUrl from './NXMUrl';

let nexus: NexusT;

export interface IExtensionContextExt extends IExtensionContext {
  registerDownloadProtocol: (
    schema: string,
    handler: (inputUrl: string) => Promise<string[]>) => void;
}

function retrieveCategories(api: IExtensionApi, isUpdate: boolean) {
  let askUser: Promise<boolean>;
  if (isUpdate) {
    askUser = api.store.dispatch(
      showDialog('question', 'Retrieve Categories', {
        text: 'Clicking RETRIEVE you will lose all your changes',
      }, [ { label: 'Cancel' }, { label: 'Retrieve' } ]))
      .then((result: IDialogResult) => {
        return result.action === 'Retrieve';
      });
  } else {
    askUser = Promise.resolve(true);
  }

  askUser.then((userContinue: boolean) => {
    if (!userContinue) {
      return;
    }

    const APIKEY = getSafe(api.store.getState(),
      ['confidential', 'account', 'nexus', 'APIKey'], '');
    if (!truthy(APIKEY)) {
      showError(api.store.dispatch,
        'An error occurred retrieving categories',
        'You are not logged in to Nexus Mods!', { allowReport: false });
    } else {
      let gameId;
      currentGame(api.store)
        .then((game: IGameStored) => {
          gameId = game.id;
          const nexusId = nexusGameId(game);
          if (nexusGames().find(game => game.domain_name === nexusId) === undefined) {
            // for all we know there could be another extension providing categories for this game
            // so we can't really display an error message or anything
            log('debug', 'game unknown on nexus', { gameId: nexusId });
            return Promise.reject(new ProcessCanceled('unsupported game'));
          }
          log('info', 'retrieve categories for game', gameId);
          return retrieveCategoryList(nexusId, nexus);
        })
        .then((categories: ICategoryDictionary) => {
          api.events.emit('update-categories', gameId, categories, isUpdate);
        })
        .catch(ProcessCanceled, () => null)
        .catch(err => {
          if (err.code === 'ESOCKETTIMEOUT') {
            api.sendNotification({
              type: 'warning',
              message: 'Timeout retrieving categories from server, please try again later.',
            });
            return;
          } else if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED'].indexOf(err.code) !== -1) {
            api.sendNotification({
              type: 'warning',
              message: 'The server refused the connection, please try again later.',
            });
            return;
          }

          const detail = processErrorMessage(err);
          let allowReport = detail.Servermessage === undefined;
          if (detail.noReport) {
            allowReport = false;
            delete detail.noReport;
          }
          showError(api.store.dispatch, 'Failed to retrieve categories', detail,
                    { allowReport });
        });
    }
  });
}

function openNexusPage(state: IState, gameIds: string[]) {
  const game = gameById(state, gameIds[0]);
  opn(`https://www.nexusmods.com/${nexusGameId(game)}`).catch(err => undefined);
}

function processAttributes(input: any) {
  const nexusChangelog = getSafe(input.nexus, ['fileInfo', 'changelog_html'], undefined);

  const modName = decodeHTML(getSafe(input, ['download', 'modInfo', 'nexus',
                                                'modInfo', 'name'], undefined));
  const fileName = decodeHTML(getSafe(input, ['download', 'modInfo', 'nexus',
                                                'fileInfo', 'name'], undefined));
  const fuzzRatio = ((modName !== undefined) && (fileName !== undefined))
    ? fuzz.ratio(modName, fileName)
    : 100;

  return ({
    modId: getSafe(input, ['download', 'modInfo', 'nexus', 'ids', 'modId'], undefined),
    fileId: getSafe(input, ['download', 'modInfo', 'nexus', 'ids', 'fileId'], undefined),
    author: getSafe(input, ['download', 'modInfo', 'nexus', 'modInfo', 'author'], undefined),
    category: getSafe(input, ['download', 'modInfo', 'nexus', 'modInfo', 'category_id'], undefined),
    pictureUrl: getSafe(input, ['download', 'modInfo', 'nexus',
                                'modInfo', 'picture_url'], undefined),
    description: getSafe(input, ['download', 'modInfo', 'nexus',
                                 'modInfo', 'description'], undefined),
    shortDescription: getSafe(input, ['download', 'modInfo', 'nexus',
                                      'modInfo', 'summary'], undefined),
    fileType: getSafe(input, ['download', 'modInfo', 'nexus',
                              'fileInfo', 'category_name'], undefined),
    isPrimary: getSafe(input, ['download', 'modInfo', 'nexus',
                               'fileInfo', 'is_primary'], undefined),
    modName,
    logicalFileName: fileName,
    changelog: truthy(nexusChangelog) ? { format: 'html', content: nexusChangelog } : undefined,
    uploadedTimestamp: getSafe(input, ['download', 'modInfo', 'nexus',
                                       'fileInfo', 'uploaded_timestamp'], undefined),
    version: getSafe(input, ['download', 'modInfo', 'nexus', 'fileInfo', 'version'], undefined),
    modVersion: getSafe(input, ['download', 'modInfo', 'nexus', 'modInfo', 'version'], undefined),
    customFileName: fuzzRatio < 50 ? `${modName} - ${fileName}` : undefined,
  });
}

function requestLogin(api: IExtensionApi, callback: (err: Error) => void) {
  let id: string;
  try {
    const uuid = require('uuid');
    id = uuid.v4();
  } catch(err) {
    // odd, still unidentified bugs where bundled modules fail to load. 
    log('warn', 'failed to import uuid module', err.message);
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    id = Array.apply(null, Array(10)).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
    // the probability that this fails for another user at exactly the same time and they both get the same
    // random number is practically 0
  }
  const connection = new WebSocket('wss://sso.nexusmods.com')
    .on('open', () => {
      connection.send(JSON.stringify({
        id, appid: 'Vortex',
      }), err => {
        if (err) {
          api.showErrorNotification('Failed to start login', err);
          connection.close();
        }
      });
      opn(`https://www.nexusmods.com/sso?id=${id}`).catch(err => undefined);
    })
    .on('message', data => {
      connection.close();
      api.store.dispatch(setUserAPIKey(data.toString()));
      remote.getCurrentWindow().setAlwaysOnTop(true);
      remote.getCurrentWindow().show();
      remote.getCurrentWindow().setAlwaysOnTop(false);
      callback(null);
    })
    .on('error', error => {
      api.showErrorNotification('Failed to connect to nexusmods.com', error, {
        allowReport: false,
      });
      connection.close();
    });
}

function doDownload(api: IExtensionApi, url: string) {
  return startDownload(api, nexus, url)
  .catch(DownloadIsHTML, () => undefined)
  // DataInvalid is used here to indicate invalid user input or invalid
  // data from remote, so it's presumably not a bug in Vortex
  .catch(DataInvalid, () => {
    api.showErrorNotification('Failed to start download', url, { allowReport: false });
  })
  .catch(err => {
    api.showErrorNotification('Failed to start download', err);
  });
}

function once(api: IExtensionApi) {
  const registerFunc = (def: boolean) => {
    api.registerProtocol('nxm', def, (url: string) => {
      if (sel.apiKey(api.store.getState()) === undefined) {
        api.sendNotification({
          type: 'info',
          title: 'Not logged in',
          message: 'Nexus Mods requires Vortex to be logged in for downloading',
          actions: [
            {
              title: 'Log in',
              action: (dismiss: () => void) => {
                requestLogin(api, (err) => {
                  if (err !== null) {
                    api.showErrorNotification('Failed to get access key', err);
                  } else {
                    dismiss();
                    doDownload(api, url);
                  }
                });
              },
            },
          ],
        });
      } else {
        doDownload(api, url);
      }
    });
  };

  { // limit lifetime of state
    const state = api.store.getState();

    const Nexus: typeof NexusT = require('nexus-api').default;
    const apiKey = getSafe(state, ['confidential', 'account', 'nexus', 'APIKey'], '');
    nexus = new Nexus(activeGameId(state), apiKey, remote.app.getVersion(), 30000);
    setApiKey(apiKey);

    retrieveNexusGames(nexus);

    const gameMode = activeGameId(state);
    api.store.dispatch(setUpdatingMods(gameMode, false));

    registerFunc(state.settings.nexus.associateNXM);

    if (state.confidential.account.nexus.APIKey !== undefined) {
      (window as any).requestIdleCallback(() => {
        validateKey(api, nexus, state.confidential.account.nexus.APIKey);
      });
    } else {
      api.store.dispatch(setUserInfo(undefined));
    }
  }

  api.onAsync('check-mods-version', eh.onCheckModsVersion(api, nexus));
  api.events.on('endorse-mod', eh.onEndorseMod(api, nexus));
  api.events.on('submit-feedback', eh.onSubmitFeedback(nexus));
  api.events.on('mod-update', eh.onModUpdate(api, nexus));
  api.events.on('open-mod-page', eh.onOpenModPage(api));
  api.events.on('request-nexus-login', callback => requestLogin(api, callback));
  api.events.on('request-own-issues', eh.onRequestOwnIssues(nexus));
  api.events.on('retrieve-category-list', (isUpdate: boolean) => {
    retrieveCategories(api, isUpdate);
  });
  api.events.on('gamemode-activated', (gameId: string) => { nexus.setGame(gameId); });
  api.events.on('did-import-downloads', (dlIds: string[]) => { queryInfo(api, dlIds); });

  api.onStateChange(['settings', 'nexus', 'associateNXM'],
    eh.onChangeNXMAssociation(registerFunc, api));
  api.onStateChange(['confidential', 'account', 'nexus', 'APIKey'],
    eh.onAPIKeyChanged(api, nexus));
  api.onStateChange(['persistent', 'mods'], eh.onChangeMods(api, nexus));
  api.onStateChange(['persistent', 'downloads', 'files'], eh.onChangeDownloads(api, nexus))

  nexus.getModInfo(1, 'site')
    .then(info => {
      api.store.dispatch(setNewestVersion(info.version));
    })
    .catch(err => {
      // typically just missing the api key or a downtime
      log('info', 'failed to determine newest Vortex version', { error: err.message });
    });
}

function toolbarBanner(t: I18next.TranslationFunction): React.StatelessComponent<any> {
  return () => {
    return (<div className='nexus-main-banner' style={{ background: 'url(assets/images/ad-banner.png)' }}>
      <div>{t('Go Premium')}</div>
      <div>{t('Uncapped downloads, no adverts')}</div>
      <div>{t('Support Nexus Mods')}</div>
      <div className='right-center'>
        <Button bsStyle='ad' onClick={goBuyPremium}>{t('Go Premium')}</Button>
      </div>
    </div>);
  };
}

function goBuyPremium() {
  opn('https://www.nexusmods.com/register/premium').catch(err => undefined);
}

function queryInfo(api: IExtensionApi, instanceIds: string[]) {
  if (instanceIds === undefined) {
    return;
  }

  const state: IState = api.store.getState();

  instanceIds.map(dlId => {
    const dl = state.persistent.downloads.files[dlId];
    const gameId = Array.isArray(dl.game) ? dl.game[0] : dl.game;
    const downloadPath = downloadPathForGame(state, gameId);
    api.lookupModMeta({
      fileMD5: dl.fileMD5,
      filePath: path.join(downloadPath, dl.localPath),
      gameId,
      fileSize: dl.size,
    })
    .then((modInfo: ILookupResult[]) => {
      if (modInfo.length > 0) {
        try {
          const nxmUrl = new NXMUrl(modInfo[0].value.sourceURI);
          api.store.dispatch(setDownloadModInfo(dlId, 'source', 'nexus'));
          api.store.dispatch(setDownloadModInfo(dlId, 'nexus.ids.gameId', nxmUrl.gameId));
          api.store.dispatch(setDownloadModInfo(dlId, 'nexus.ids.fileId', nxmUrl.fileId));
          api.store.dispatch(setDownloadModInfo(dlId, 'nexus.ids.modId', nxmUrl.modId));
        } catch (err) {
          // failed to parse the uri as an nxm link - that's not an error in this case, if
          // the meta server wasn't nexus mods this is to be expected
        }
      }
    })
    .catch(err => {
      log('warn', 'failed to look up mod meta info', { message: err.message });
    });
  });
}

function init(context: IExtensionContextExt): boolean {
  context.registerAction('application-icons', 200, LoginIcon, {}, () => ({ nexus }));
  context.registerAction('mods-action-icons', 999, 'open-ext', {}, 'Open on Nexus Mods', instanceIds => {
    const state: IState = context.api.store.getState();
    const gameMode = activeGameId(state);
    const mod: IMod = getSafe(state.persistent.mods, [gameMode, instanceIds[0]], undefined);
    if (mod !== undefined) {
      const gameId = mod.attributes.downloadGame !== undefined ? mod.attributes.downloadGame : gameMode;
      context.api.events.emit('open-mod-page', gameId, mod.attributes.modId);
    }
  }, instanceIds => {
    const state: IState = context.api.store.getState();
    const gameMode = activeGameId(state);
    return getSafe(state.persistent.mods, [gameMode, instanceIds[0], 'attributes', 'source'], undefined) === 'nexus';
  });
  context.registerAction('downloads-action-icons', 100, 'refresh', {}, 'Query Info',
    (instanceIds: string[]) => queryInfo(context.api, instanceIds));
  context.registerAction('downloads-multirow-actions', 100, 'refresh', {}, 'Query Info',
    (instanceIds: string[]) => queryInfo(context.api, instanceIds));

  context.registerSettings('Download', LazyComponent(() => require('./views/Settings')));
  context.registerReducer(['confidential', 'account', 'nexus'], accountReducer);
  context.registerReducer(['settings', 'nexus'], settingsReducer);
  context.registerReducer(['persistent', 'nexus'], persistentReducer);
  context.registerDialog('login-dialog', LoginDialog, () => ({ nexus }));
  context.registerBanner('downloads', () => {
    const t = context.api.translate;
    return (
      <div className='nexus-download-banner'>
        {t('Nexus downloads are capped at 1MB/s - '
          + 'Go Premium for uncapped download speeds')}
        <Button bsStyle='ad' onClick={goBuyPremium}>{t('Go Premium')}</Button>
      </div>);
  }, {
    props: {
      isPremium: state => getSafe(state, ['persistent', 'nexus', 'userInfo', 'isPremium'], false),
    },
    condition: (props: any): boolean => !props.isPremium,
  });

  context.registerBanner('main-toolbar', toolbarBanner(context.api.translate), {
    props: {
      isPremium: state => getSafe(state, ['persistent', 'nexus', 'userInfo', 'isPremium'], false),
      isSupporter: state =>
        getSafe(state, ['persistent', 'nexus', 'userInfo', 'isSupporter'], false),
    },
    condition: (props: any): boolean => !props.isPremium && !props.isSupporter,
  });

  const associateNXM = () => {
    const state: any = context.api.store.getState();
    context.api.store.dispatch(setAssociatedWithNXMURLs(!state.settings.nexus.associateNXM));
  };

  context.registerModSource('nexus', 'Nexus Mods', () => {
    currentGame(context.api.store)
      .then(game => {
        opn(`https://www.nexusmods.com/${nexusGameId(game)}`).catch(err => undefined);
      });
  });

  context.registerToDo('nxm-associated', 'settings', () => ({
    associated: context.api.store.getState().settings.nexus.associateNXM,
  }), 'link', 'Handle Nexus Links', associateNXM, undefined, (t, props: any) =>
    <span>{props.associated ? t('Yes') : t('No')}</span>, 15);

  context.registerAction('download-icons', 100, InputButton, {},
    () => ({
      key: 'input-nxm-url',
      id: 'input-nxm-url',
      groupId: 'download-buttons',
      icon: 'nexus',
      tooltip: 'Download NXM URL',
      onConfirmed: (nxmurl: string) => startDownload(context.api, nexus, nxmurl),
    }));

  context.registerAction('categories-icons', 100, 'download', {}, 'Retrieve categories',
    () => retrieveCategories(context.api, true));

  context.registerTableAttribute('mods', genEndorsedAttribute(context.api,
    (gameId: string, modId: string, endorseStatus: string) => endorseModImpl(context.api, nexus, gameId, modId, endorseStatus)));
  context.registerTableAttribute('mods', genGameAttribute(context.api));
  context.registerTableAttribute('mods', genModIdAttribute(context.api));

  context.registerDashlet('Nexus Mods Account Banner', 3, 1, 0, DashboardBanner, undefined, undefined, {
    fixed: true,
    closable: true,
  });

  context.registerDashlet('Go Premium', 1, 2, 200, GoPremiumDashlet, (state: IState) =>
    (getSafe(state, ['persistent', 'nexus', 'userInfo', 'isPremium'], undefined) !== true)
    && (getSafe(state, ['persistent', 'nexus', 'userInfo', 'isSupporter'], undefined) !== true),
    undefined, {
    fixed: false,
    closable: false,
  });

  context.registerAttributeExtractor(50, (input: any) => {
    return Promise.resolve(processAttributes(input));
  });

  context.registerAction('game-discovered-buttons', 120, 'nexus', {},
                         context.api.translate('Open Nexus Page'),
                         (games: string[]) => openNexusPage(context.api.store.getState(), games));

  context.registerAction('game-managed-buttons', 120, 'nexus', {},
                         context.api.translate('Open Nexus Page'),
                         (games: string[]) => openNexusPage(context.api.store.getState(), games));

  context.registerAction('game-undiscovered-buttons', 120, 'nexus', {},
                         context.api.translate('Open Nexus Page'),
                         (games: string[]) => openNexusPage(context.api.store.getState(), games));

  context.once(() => once(context.api));

  return true;
}

export default init;
