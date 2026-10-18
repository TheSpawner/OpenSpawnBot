const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ARCH = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
const LAST_ONNXRUNTIME_WITH = { 'darwin-x64': '1.23.2' };

function appFolder(context) {
  if (context.electronPlatformName !== 'darwin') return path.join(context.appOutDir, 'resources', 'app');
  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app');
}

function replaceOnnxRuntime(target, version) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'onnxruntime-'));
  try {
    execFileSync('npm', ['pack', `onnxruntime-node@${version}`, '--silent'], { cwd: work, shell: process.platform === 'win32' });
    execFileSync('tar', ['xzf', `onnxruntime-node-${version}.tgz`], { cwd: work });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(work, 'package'), target, { recursive: true });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH[context.arch];
  const onnx = path.join(appFolder(context), 'node_modules', 'onnxruntime-node');
  if (!fs.existsSync(onnx)) return;
  const bins = path.join(onnx, 'bin', 'napi-v6');

  if (!fs.existsSync(path.join(bins, platform, arch, 'onnxruntime_binding.node'))) {
    const version = LAST_ONNXRUNTIME_WITH[`${platform}-${arch}`];
    if (!version) throw new Error(`onnxruntime-node has no binary for ${platform}-${arch}`);
    replaceOnnxRuntime(onnx, version);
    console.log(`  • onnxruntime-node ${version} for ${platform}-${arch}, the last release that ships it`);
  }

  for (const system of fs.readdirSync(bins)) {
    for (const cpu of fs.readdirSync(path.join(bins, system))) {
      if (system !== platform || cpu !== arch) fs.rmSync(path.join(bins, system, cpu), { recursive: true, force: true });
    }
    if (!fs.readdirSync(path.join(bins, system)).length) fs.rmSync(path.join(bins, system), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(bins, platform, arch, 'onnxruntime_binding.node'))) throw new Error(`onnxruntime-node ${platform}-${arch} binary is missing after packing`);
};
