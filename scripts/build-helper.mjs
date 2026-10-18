import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('Skipped the macOS desktop helper: it is only built on macOS.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native', 'macos', 'desktop-helper-macos.m');
const output = path.join(root, 'helpers', 'macos', 'desktop-helper-macos');
const identity = process.env.OPENSPAWN_IDENTITY || 'OpenSpawn';

fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync('clang', [
  '-arch', 'x86_64', '-arch', 'arm64',
  '-fobjc-arc', '-O2', '-mmacosx-version-min=13.0',
  '-framework', 'Foundation',
  '-framework', 'ApplicationServices',
  '-framework', 'CoreGraphics',
  '-framework', 'AppKit',
  '-framework', 'ScreenCaptureKit',
  source, '-o', output
], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', identity, '--timestamp=none', output], { stdio: 'inherit' });

console.log(`Built helpers/macos/desktop-helper-macos (x86_64 + arm64, ${Math.round(fs.statSync(output).size / 1024)} KB), signed by ${identity}.`);
