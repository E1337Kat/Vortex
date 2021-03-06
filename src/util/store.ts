import reducer, { Decision } from '../reducers/index';
import { IPersistor, PersistingType } from '../types/IExtensionContext';
import { IState } from '../types/IState';

import ExtensionManager from './ExtensionManager';
import * as fs from './fs';
import { log } from './log';
import ReduxPersistor from './ReduxPersistor';
import {reduxSanity, StateError} from './reduxSanity';

import * as Promise from 'bluebird';
import { dialog } from 'electron';
import * as levelup from 'levelup';
import * as path from 'path';
import * as Redux from 'redux';
import { applyMiddleware, compose, createStore } from 'redux';
import { forwardToRenderer, replayActionMain } from 'electron-redux';
import thunkMiddleware from 'redux-thunk';

let basePersistor: ReduxPersistor<IState>;

const IMPORTED_TAG = 'imported__do_not_delete.txt';

export const currentStatePath = 'state.v2';

export function querySanitize(): Decision {
  const response = dialog.showMessageBox(null, {
    message:
        'Application state is invalid. I can try to repair it but you may lose data',
    buttons: ['Quit', 'Ignore', 'Backup and Repair'],
  });

  return [Decision.QUIT, Decision.IGNORE, Decision.SANITIZE][response];
}

export function createVortexStore(sanityCallback: (err: StateError) => void): Redux.Store<IState> {
  const middleware = [
    thunkMiddleware,
    reduxSanity(sanityCallback),
  ];

  const enhancer: Redux.StoreEnhancer<IState> =
      compose(applyMiddleware(
          ...middleware,
          forwardToRenderer,
        )) as Redux.StoreEnhancer<any>;

  const store = createStore<IState, Redux.Action, any, any>(reducer([], querySanitize), enhancer);
  basePersistor = new ReduxPersistor(store);
  replayActionMain(store);
  return store;
}

export function insertPersistor(hive: string, persistor: IPersistor): Promise<void> {
  return basePersistor.insertPersistor(hive, persistor);
}

export function allHives(extensions: ExtensionManager): string[] {
  const hives = ['settings', 'persistent', 'confidential'];
  extensions.apply('registerSettingsHive',
                   (hive: string, type: PersistingType) => {
                     if (type === 'global') {
                       hives.push(hive);
                     }
                   });
  return hives;
}

/**
 * apply the registerPersistor extensions to this store
 *
 * @export
 * @param {Redux.Store<IState>} store
 * @param {ExtensionManager} extensions
 * @returns {Promise<void>}
 */
export function extendStore(store: Redux.Store<IState>,
                            extensions: ExtensionManager): Promise<void> {
  let queue = Promise.resolve();
  extensions.apply('registerPersistor', (hive: string, persistor: IPersistor,
                                         debounce?: number) => {
    queue = queue.then(() => insertPersistor(hive, persistor));
  });
  return queue;
}

function importStateV1(importPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    (levelup as any)(importPath, undefined, (err, db: levelup.LevelUp) => {
      if (err !== null) {
        log('info', 'failed to open db', err);
        reject(err);
      } else {
        const res = {};
        db.createReadStream()
          .on('data', data => {
            if (data.key.startsWith('global_')) {
              res[data.key.substr(7)] = JSON.parse(data.value);
            }
          })
          .on('error', error => {
            reject(error);
          })
          .on('end', () => {
            resolve(res);
          });
      }
    });
  });
}

function exists(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    } else {
      throw err;
    }
  }
}

export function markImported(basePath: string): Promise<void> {
  return fs.writeFileAsync(
    path.join(basePath, currentStatePath, IMPORTED_TAG), '');
}

export function importState(basePath: string): Promise<any> {
  if (exists(path.join(basePath, currentStatePath, IMPORTED_TAG))) {
    return Promise.resolve();
  }

  const versionDirs = [
    { path: path.join(basePath, 'state'), func: importStateV1 },
  ];

  // find the newest previous version to import from
  const importVer = versionDirs.find(ver => exists(ver.path));

  return ((importVer !== undefined) && (importVer.func !== null))
    // read and transform data to import
    ? importVer.func(importVer.path)
    : Promise.resolve();
}
