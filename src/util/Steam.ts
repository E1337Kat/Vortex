import * as Promise from 'bluebird';

import * as fs from './fs';
import { log } from './log';
import { getSafeCI } from './storeHelper';

import { app as appIn, remote } from 'electron';
import * as path from 'path';
import { parse } from 'simple-vdf';
import * as winapi from 'winapi-bindings';

const app = (remote !== undefined) ? remote.app : appIn;

export interface ISteamEntry {
  appid: string;
  name: string;
  gamePath: string;
  lastUpdated: Date;
}

export class GameNotFound extends Error {
  private mSearch;
  constructor(search: string) {
    super('Not in Steam library');
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.mSearch = search;
  }
  public get search() {
    return this.mSearch;
  }
}

export interface ISteam {
  findByName(namePattern: string): Promise<ISteamEntry>;
  findByAppId(appId: string | string[]): Promise<ISteamEntry>;
  allGames(): Promise<ISteamEntry[]>;
}

/**
 * base class to interact with local steam installation
 *
 * @class Steam
 */
class Steam implements ISteam {
  public static GameNotFound = GameNotFound;
  private mBaseFolder: Promise<string>;
  private mCache: Promise<ISteamEntry[]>;

  constructor() {
    if (process.platform === 'win32') {
        // windows
        try {
          const steamPath = winapi.RegGetValue('HKEY_CURRENT_USER', 'Software\\Valve\\Steam', 'SteamPath');
          this.mBaseFolder = Promise.resolve(steamPath.value as string);
        }
        catch (err) {
          log('info', 'steam not found', { error: err.message });
          this.mBaseFolder = Promise.resolve(undefined);
        }
    } else {
      this.mBaseFolder = Promise.resolve(path.resolve(app.getPath('home'), '.steam', 'steam'));
    }
  }

  /**
   * find the first game that matches the specified name pattern
   */
  public findByName(namePattern: string): Promise<ISteamEntry> {
    const re = new RegExp(namePattern);
    return this.allGames()
      .then(entries => entries.find(entry => re.test(entry.name)))
      .then(entry => {
        if (entry === undefined) {
          return Promise.reject(new Steam.GameNotFound(namePattern));
        } else {
          return Promise.resolve(entry);
        }
      });
  }

  /**
   * find the first game with the specified appid or one of the specified appids
   */
  public findByAppId(appId: string | string[]): Promise<ISteamEntry> {
    // support searching for one app id or one out of a list (when there are multiple
    // variants of a game)
    const matcher = Array.isArray(appId)
      ? entry => appId.indexOf(entry.appid) !== -1
      : entry => entry.appid === appId;

    return this.allGames()
      .then(entries => entries.find(matcher))
      .then(entry => {
        if (entry === undefined) {
          return Promise.reject(new GameNotFound(Array.isArray(appId) ? appId.join(', ') : appId));
        } else {
          return Promise.resolve(entry);
        }
      });
  }

  public allGames(): Promise<ISteamEntry[]> {
    if (this.mCache === undefined) {
      this.mCache = this.parseManifests();
    }
    return this.mCache;
  }

  private parseManifests(): Promise<ISteamEntry[]> {
    const steamPaths: string[] = [];
    return this.mBaseFolder
      .then((basePath: string) => {
        if (basePath === undefined) {
          return Promise.resolve(undefined);
        }
        steamPaths.push(basePath);
        return fs.readFileAsync(path.resolve(basePath, 'config', 'config.vdf'));
      })
      .then((data: Buffer) => {
        if (data === undefined) {
          return Promise.resolve([]);
        }

        let configObj;
        try {
          configObj = parse(data.toString());
        } catch (err) {
          return Promise.resolve([]);
        }

        let counter = 1;
        const steamObj: any =
          getSafeCI(configObj, ['InstallConfigStore', 'Software', 'Valve', 'Steam'], {});
        while (steamObj.hasOwnProperty(`BaseInstallFolder_${counter}`)) {
          steamPaths.push(steamObj[`BaseInstallFolder_${counter}`]);
          ++counter;
        }

        return Promise.all(Promise.map(steamPaths, steamPath => {
          const steamAppsPath = path.join(steamPath, 'steamapps');
          return fs.readdirAsync(steamAppsPath)
            .then(names => {
              const filtered = names.filter(name =>
                name.startsWith('appmanifest_') && (path.extname(name) === '.acf'));
              return Promise.map(filtered, (name: string) =>
                fs.readFileAsync(path.join(steamAppsPath, name)));
            })
            .then((appsData: Buffer[]) => {
              return appsData.map(appData => parse(appData.toString())).map(obj =>
                ({
                  appid: obj['AppState']['appid'],
                  name: obj['AppState']['name'],
                  gamePath: path.join(steamAppsPath, 'common', obj['AppState']['installdir']),
                  lastUpdated: new Date(obj['AppState']['LastUpdated'] * 1000),
                }));
            })
            .catch(err => {
              log('warn', 'Failed to read steam library', err.message);
            });
        }));
      })
      .then((games: ISteamEntry[][]) =>
        games.reduce((prev: ISteamEntry[], current: ISteamEntry[]): ISteamEntry[] =>
          prev.concat(current), []));
  }
}

const instance: ISteam = new Steam();

export default instance;
