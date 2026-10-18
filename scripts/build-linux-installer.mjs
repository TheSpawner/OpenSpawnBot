import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const unpacked = path.join(dist, 'linux-unpacked');
const stage = path.join(dist, 'installer-stage');
const payload = path.join(dist, 'installer-payload.tar.gz');
const output = path.join(dist, 'OpenSpawn-Bot-Installer.sh');

if (!fs.existsSync(unpacked)) throw new Error(`No ${unpacked}. Run: npx electron-builder --linux dir --x64`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const linux = manifest.build.linux;
const productName = manifest.build.productName;
const executableName = linux.executableName;

fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(payload, { force: true });

const appDir = path.join(stage, 'opt', productName);
fs.mkdirSync(path.join(stage, 'opt'), { recursive: true });
fs.cpSync(unpacked, appDir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });

const linuxResources = path.join(appDir, 'resources', 'linux');
fs.mkdirSync(path.join(linuxResources, 'icons'), { recursive: true });
for (const script of ['after-install.sh', 'after-remove.sh']) {
  fs.copyFileSync(path.join(root, 'build', 'linux', script), path.join(linuxResources, script));
  fs.chmodSync(path.join(linuxResources, script), 0o755);
}
for (const icon of fs.readdirSync(path.join(root, linux.icon))) {
  if (/^\d+x\d+\.png$/.test(icon)) fs.copyFileSync(path.join(root, linux.icon, icon), path.join(linuxResources, 'icons', icon));
}

const desktop = [
  '[Desktop Entry]',
  `Name=${productName}`,
  `Exec="/opt/${productName}/${executableName}" %U`,
  'Terminal=false',
  'Type=Application',
  `Icon=${executableName}`,
  `StartupWMClass=${linux.desktop?.entry?.StartupWMClass || productName}`,
  `Comment=${linux.description || manifest.description}`,
  `Categories=${String(linux.category || 'Utility').replace(/;+$/, '')};`,
  ''
].join('\n');
fs.mkdirSync(path.join(stage, 'usr', 'share', 'applications'), { recursive: true });
fs.writeFileSync(path.join(stage, 'usr', 'share', 'applications', `${executableName}.desktop`), desktop);

fs.mkdirSync(path.join(stage, 'usr', 'bin'), { recursive: true });
const uninstall = path.join(stage, 'usr', 'bin', `${executableName}-uninstall`);
fs.copyFileSync(path.join(root, 'build', 'linux', 'script-uninstall.sh'), uninstall);
fs.chmodSync(uninstall, 0o755);

const owner = process.platform === 'linux'
  ? ['--owner=0', '--group=0']
  : ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root', '--no-xattrs', '--no-mac-metadata', '--no-acls', '--format', 'gnutar'];
execFileSync('tar', ['czf', payload, '-C', stage, ...owner, 'opt', 'usr'], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });

const header = fs.readFileSync(path.join(root, 'build', 'linux', 'installer-header.sh'));
fs.writeFileSync(output, Buffer.concat([header, fs.readFileSync(payload)]));
fs.chmodSync(output, 0o755);

fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(payload, { force: true });

console.log(`  ${path.basename(output)}  ${(fs.statSync(output).size / 1024 / 1024).toFixed(0)} MB`);
