import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '44.3.0';
const DIR = join(ROOT, 'runtime', 'electron');
const BINARY = { win32: join(DIR, 'electron.exe'), darwin: join(DIR, 'Electron.app', 'Contents', 'MacOS', 'Electron'), linux: join(DIR, 'electron') }[process.platform];
if (!BINARY) { console.error(`Unsupported platform: ${process.platform}`); process.exit(1); }

if (!existsSync(BINARY)) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `electron-v${VERSION}-${process.platform}-${arch}.zip`;
  const url = `https://github.com/electron/electron/releases/download/v${VERSION}/${name}`;
  const zip = join(ROOT, 'runtime', name);
  mkdirSync(DIR, { recursive: true });
  console.log(`Downloading the app runtime (${name}, about 100 MB) — once only…`);
  const response = await fetch(url);
  if (!response.ok) { console.error(`Download failed: HTTP ${response.status} for ${url}`); process.exit(1); }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zip));
  const unzip = process.platform === 'darwin' ? ['ditto', ['-x', '-k', zip, DIR]]
    : process.platform === 'win32' ? ['tar', ['-xf', zip, '-C', DIR]]
    : ['unzip', ['-q', '-o', zip, '-d', DIR]];
  let result = spawnSync(unzip[0], unzip[1], { stdio: 'inherit' });
  if (result.status !== 0 && process.platform === 'linux') result = spawnSync('python3', ['-m', 'zipfile', '-e', zip, DIR], { stdio: 'inherit' });
  if (result.status !== 0) { console.error('Could not unpack the runtime.'); process.exit(1); }
  rmSync(zip, { force: true });
  if (process.platform !== 'win32') chmodSync(BINARY, 0o755);
}

const child = spawn(BINARY, [ROOT], { cwd: ROOT, detached: true, stdio: 'ignore' });
child.unref();
console.log('OpenSpawn Bot is starting…');
