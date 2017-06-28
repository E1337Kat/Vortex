import * as Promise from 'bluebird';
import { app as appIn, remote } from 'electron';
import * as fs from 'fs-extra-promise';
import ZipT = require('node-7z');
import * as path from 'path';
import * as rimraf from 'rimraf';

const app = appIn || remote.app;

type rimrafType = (path: string, options: any, callback: (err?) => void) => void;
const rimrafAsync = Promise.promisify(rimraf as rimrafType);

function installExtension(archivePath: string): Promise<void> {
  const extensionsPath = path.join(app.getPath('userData'), 'plugins');
  const destPath = path.join(extensionsPath, path.basename(archivePath, path.extname(archivePath)));
  const tempPath = destPath + '.installing';

  const Zip: typeof ZipT = require('node-7z');
  const extractor = new Zip();

  return extractor.extractFull(archivePath, tempPath, {ssc: false}, () => undefined,
                        () => undefined)
      .then(() => Promise.all([
        fs.statAsync(path.join(tempPath, 'info.json')),
        fs.statAsync(path.join(tempPath, 'info.json')),
      ]))
      .then(() => fs.renameAsync(tempPath, destPath))
      .catch(() => rimrafAsync(tempPath, { glob: false }));
}

export default installExtension;