import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, openSync, mkdirSync, renameSync, rmSync, createWriteStream, statSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { ROOT, DATA, RUNTIME, readJSON, writeJSON, sleep } from './util.mjs';

const TAR = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const CONFIG_FILE = join(DATA, 'config.json');

export const MODEL = {
  name: 'Qwen3.5-0.8B',
  file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
  bytes: 532517120,
  mmproj: { file: 'mmproj-Qwen3.5-0.8B-F16.gguf', url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf', bytes: 204987232 },
  nativeContext: 262144
};
export const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072, 262144];
const DEFAULTS = { gpu: true, llmPort: 8081, searchPort: 8888, port: 7777, context: 'max', slots: 2, vision: true, approvals: 'ask' };

export const config = { ...DEFAULTS, ...readJSON(CONFIG_FILE, {}), gpu: true, vision: true };
delete config.model;
export const saveConfig = changes => { Object.assign(config, changes); const { model, ...rest } = config; writeJSON(CONFIG_FILE, rest); };

export const state = { llm: 'starting', context: null, vision: false, download: null, error: null, backend: null, downloaded: 0 };
export const SIZES = { runtime: process.platform === 'darwin' ? 11e6 : 54e6, model: MODEL.bytes, vision: MODEL.mmproj.bytes };

const children = new Map();
const up = async (url, ms = 1200) => { try { return (await fetch(url, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; } };
export const llmUp = (ms = 1200) => up(`http://127.0.0.1:${config.llmPort}/health`, ms);
export const searchUp = (ms = 1200) => up(`http://127.0.0.1:${config.searchPort}/healthz`, ms).then(ok => ok || up(`http://127.0.0.1:${config.searchPort}/`, ms));

function launch(name, exe, args, options, { append = false } = {}) {
  const log = openSync(join(DATA, `${name}.log`), append ? 'a' : 'w');
  const child = spawn(exe, args, { ...options, stdio: ['ignore', log, log], windowsHide: true });
  children.set(name, child);
  child.on('exit', () => { if (children.get(name) === child) children.delete(name); });
  return child;
}
async function waitFor(check, ms, alive = () => true) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return true; if (!alive()) return false; await sleep(400); }
  return false;
}

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
function llamaDirs() {
  const order = process.platform === 'win32' ? ['llama-vulkan', 'llama'] : process.platform === 'darwin' ? ['llama-macos'] : ['llama-linux-vulkan', 'llama-linux'];
  return (config.gpu ? order : order.slice().reverse()).map(d => join(RUNTIME, d)).filter(d => existsSync(join(d, EXE)) || existsSync(join(d, 'build', 'bin', EXE)));
}
const exeIn = dir => existsSync(join(dir, EXE)) ? join(dir, EXE) : join(dir, 'build', 'bin', EXE);

export function missing() {
  const out = [];
  if (!llamaDirs().length) out.push('runtime');
  if (!existsSync(join(RUNTIME, MODEL.file))) out.push('model');
  if (config.vision && !existsSync(join(RUNTIME, MODEL.mmproj.file))) out.push('vision');
  return out;
}

async function download(url, file, label) {
  mkdirSync(join(file, '..'), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const part = file + '.part';
  if (!label) { await pipeline(Readable.fromWeb(response.body), createWriteStream(part)); return renameSync(part, file); }
  state.download = { label, received: 0, total };
  const counter = new Transform({ transform(chunk, _e, done) { state.download.received += chunk.length; done(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part));
  state.downloaded += state.download.received;
  renameSync(part, file);
}

const LLAMA = 'b10881';
function llamaBuilds() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const builds = process.platform === 'win32' ? [['llama-vulkan', `win-vulkan-${arch}.zip`], ['llama', `win-cpu-${arch}.zip`]]
    : process.platform === 'darwin' ? [['llama-macos', `macos-${arch}.tar.gz`]]
    : [['llama-linux-vulkan', `ubuntu-vulkan-${arch}.tar.gz`], ['llama-linux', `ubuntu-${arch}.tar.gz`]];
  return builds.map(([dir, asset]) => ({ dir: join(RUNTIME, dir), name: `llama-${LLAMA}-bin-${asset}` }));
}

async function installLlama({ dir, name }) {
  const archive = join(RUNTIME, name);
  await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA}/${name}`, archive, `llama.cpp runtime (${name})`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(TAR, [name.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', dir], { windowsHide: true });
  rmSync(archive, { force: true });
  if (r.status !== 0) throw new Error('could not unpack the llama.cpp runtime');
  if (!existsSync(join(dir, EXE))) { const inner = readdirSync(dir).map(n => join(dir, n)).find(p => existsSync(join(p, EXE))); if (inner) for (const n of readdirSync(inner)) renameSync(join(inner, n), join(dir, n)); }
  if (!existsSync(exeIn(dir))) throw new Error(`${name} has no ${EXE}`);
  if (process.platform !== 'win32') chmodSync(exeIn(dir), 0o755);
}

let downloading = null;
export function downloadMissing() {
  downloading ||= (async () => {
    try {
      const need = missing();
      if (need.includes('runtime')) {
        const failures = [];
        for (const build of llamaBuilds()) {
          if (existsSync(join(build.dir, EXE))) continue;
          try { await installLlama(build); } catch (error) { failures.push(error.message); }
        }
        if (!llamaDirs().length) throw new Error(failures[0] || 'no llama.cpp runtime for this computer');
      }
      if (need.includes('model')) await download(MODEL.url, join(RUNTIME, MODEL.file), `${MODEL.name} (${(MODEL.bytes / 1e6).toFixed(0)} MB)`);
      if (need.includes('vision')) await download(MODEL.mmproj.url, join(RUNTIME, MODEL.mmproj.file), `${MODEL.name} vision projector`);
      state.download = null;
      return { ok: true };
    } catch (error) {
      state.download = { label: 'failed', error: error.message };
      return { ok: false, error: error.message };
    } finally { downloading = null; }
  })();
  return downloading;
}

const portBusy = port => new Promise(resolve => {
  import('node:net').then(({ createServer }) => {
    const probe = createServer().once('error', () => resolve(true)).once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
});
async function props() { try { return await (await fetch(`http://127.0.0.1:${config.llmPort}/props`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; } }

let starting = null;
export function startLLM() {
  starting ||= startLLMOnce().finally(() => { starting = null; });
  return starting;
}
async function startLLMOnce() {
  if (await llmUp(5000) || await portBusy(config.llmPort)) {
    for (let i = 0; i < 20 && !(await llmUp(5000)); i++) await sleep(500);
    const p = await props();
    state.llm = 'ready'; state.context = p?.default_generation_settings?.n_ctx || null; state.vision = Boolean(p?.modalities?.vision); state.backend = 'already running';
    return { ok: true, already: true };
  }
  const need = missing().filter(m => m !== 'vision');
  if (need.length) { state.llm = 'missing'; state.error = `Missing: ${need.join(', ')}. Use Download in Settings.`; return { ok: false, missing: need, error: state.error }; }
  const dirs = llamaDirs();
  const vision = config.vision && existsSync(join(RUNTIME, MODEL.mmproj.file));
  const wanted = config.context === 'max' ? MODEL.nativeContext : Math.min(Number(config.context) || 32768, MODEL.nativeContext);
  const tries = CONTEXT_STEPS.filter(c => c <= wanted).reverse();
  state.llm = 'starting';
  for (const dir of dirs) {
    const gpu = /vulkan|macos/.test(dir);
    for (const context of tries) {
      const args = ['-m', join(RUNTIME, MODEL.file), '--host', '127.0.0.1', '--port', String(config.llmPort), '-c', String(context * config.slots), '-np', String(config.slots), '--alias', 'mouth', '--jinja', '-fa', 'on'];
      if (vision) args.push('--mmproj', join(RUNTIME, MODEL.mmproj.file));
      if (gpu) args.push('-ngl', '99');
      if (/vulkan/.test(dir)) args.push('--device', 'Vulkan0');
      for (let i = 0; i < 20 && await portBusy(config.llmPort); i++) await sleep(500);
      const child = launch('llm', exeIn(dir), args, { cwd: dir }, { append: context !== tries[0] || dir !== dirs[0] });
      let alive = true; child.on('exit', () => { alive = false; });
      if (await waitFor(llmUp, 120_000, () => alive)) {
        state.llm = 'ready'; state.context = context; state.vision = vision; state.backend = `${dir.split(/[\\/]/).pop()}${gpu ? ' (GPU)' : ' (CPU)'}`; state.error = null;
        child.on('exit', () => { if (children.get('llm') === child || !children.has('llm')) { if (!state.stopping) state.llm = 'crashed'; } });
        return { ok: true, context };
      }
      try { child.kill(); } catch {}
      await sleep(500);
    }
  }
  state.llm = 'off'; state.error = 'The language model would not start; see data/llm.log';
  return { ok: false, error: state.error };
}

export async function restartLLM() {
  const child = children.get('llm');
  if (!child && await llmUp(3000)) return { ok: false, error: 'The model server running now was not started by this app; close it first.' };
  state.stopping = true;
  if (child) { child.kill(); await sleep(1200); }
  state.stopping = false;
  return startLLM();
}

const SEARCH = {
  dir: join(RUNTIME, 'searxng'),
  files: join(ROOT, 'helpers', 'searxng'),
  commit: '1c10abe2d3e4ab7ddcc4e9da1a7d07dc7ca7f8f4',
  python: { tag: '20261013', version: '3.13.16' }
};
const PYTHON = join(RUNTIME, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));

function searchPython() {
  const venv = join(SEARCH.dir, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  if (existsSync(venv)) return venv;
  return existsSync(join(SEARCH.dir, 'ready')) && existsSync(PYTHON) ? PYTHON : null;
}
export const searchInstalled = () => Boolean(searchPython());

const run = (cmd, args, options = {}) => new Promise(resolve => {
  const p = spawn(cmd, args, { windowsHide: true, ...options });
  let err = '';
  p.stderr?.on('data', d => { err = (err + d).slice(-2000); });
  p.on('error', e => resolve({ code: -1, err: e.message }));
  p.on('exit', code => resolve({ code, err }));
});
function unpack(archive, dir, members = []) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(TAR, ['-xzf', archive, '-C', dir, ...members], { windowsHide: true });
  rmSync(archive, { force: true });
  if (r.status !== 0) throw new Error(`could not unpack ${archive.split(/[\\/]/).pop()}`);
}

let installingSearch = null;
export function installSearch() {
  installingSearch ||= (async () => {
    try {
      rmSync(SEARCH.dir, { recursive: true, force: true });
      if (!existsSync(PYTHON)) {
        rmSync(join(RUNTIME, 'python'), { recursive: true, force: true });
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
        const os = process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu';
        const name = `cpython-${SEARCH.python.version}+${SEARCH.python.tag}-${arch}-${os}-install_only_stripped.tar.gz`;
        const archive = join(RUNTIME, name);
        await download(`https://github.com/astral-sh/python-build-standalone/releases/download/${SEARCH.python.tag}/${encodeURIComponent(name)}`, archive);
        unpack(archive, RUNTIME);
      }
      const staging = join(RUNTIME, 'searxng-staging');
      rmSync(staging, { recursive: true, force: true });
      const source = join(RUNTIME, 'searxng.tar.gz');
      await download(`https://github.com/searxng/searxng/archive/${SEARCH.commit}.tar.gz`, source);
      const top = `searxng-${SEARCH.commit}`;
      unpack(source, staging, [`${top}/searx`, `${top}/requirements.txt`, `${top}/LICENSE`]);
      renameSync(join(staging, top), SEARCH.dir);
      rmSync(staging, { recursive: true, force: true });
      const pip = await run(PYTHON, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '-q', '-r', join(SEARCH.dir, 'requirements.txt')]);
      if (pip.code !== 0) throw new Error(`its packages did not install: ${pip.err.trim().slice(-300)}`);
      writeFileSync(join(SEARCH.dir, 'settings.yml'), readFileSync(join(SEARCH.files, 'settings.yml'), 'utf8').replace('SECRET', randomBytes(24).toString('hex')));
      writeFileSync(join(SEARCH.dir, 'ready'), SEARCH.commit);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `SearXNG could not be installed (${error.message}); direct search engines will be used` };
    }
  })().finally(() => { installingSearch = null; });
  return installingSearch;
}

export async function startSearch() {
  if (await searchUp()) return { ok: true, already: true };
  const python = searchPython();
  if (!python) return { ok: false, error: 'SearXNG is not installed; direct search engines will be used' };
  const paths = process.platform === 'win32' ? [join(SEARCH.files, 'windows'), SEARCH.dir] : [SEARCH.dir];
  launch('search', python, ['-m', 'searx.webapp'], {
    cwd: SEARCH.dir,
    env: { ...process.env, PYTHONPATH: paths.join(process.platform === 'win32' ? ';' : ':'), SEARXNG_SETTINGS_PATH: join(SEARCH.dir, 'settings.yml'), PYTHONIOENCODING: 'utf-8' }
  });
  const ok = await waitFor(searchUp, 45_000);
  return ok ? { ok: true } : { ok: false, error: 'SearXNG did not start; direct search engines will be used' };
}

export function shutdown() {
  state.stopping = true;
  for (const child of children.values()) { try { child.kill(); } catch {} }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { shutdown(); process.exit(0); });
process.on('exit', shutdown);
