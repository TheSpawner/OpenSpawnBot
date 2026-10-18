import { spawn } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { ROOT, RUNTIME } from '../util.mjs';
import { PLATFORM } from './platform.mjs';

const SOURCES = join(ROOT, 'helpers');
const BINARIES = join(RUNTIME, 'helpers');
const VENV = join(RUNTIME, 'helper-venv');
const VENV_PYTHON = join(VENV, 'Scripts', 'python.exe');

function command() {
  if (PLATFORM === 'win32') {
    if (existsSync(VENV_PYTHON)) return { cmd: VENV_PYTHON, args: ['-X', 'utf8', '-m', 'desktop_runtime'], cwd: join(SOURCES, 'windows') };
    const exe = join(BINARIES, 'desktop-runtime.exe');
    if (existsSync(exe)) return { cmd: exe, args: [], cwd: BINARIES };
    return { cmd: 'py', args: ['-3', '-X', 'utf8', '-m', 'desktop_runtime'], cwd: join(SOURCES, 'windows') };
  }
  if (PLATFORM === 'darwin') {
    const shipped = join(SOURCES, 'macos', 'desktop-helper-macos');
    const helper = existsSync(shipped) ? shipped : join(BINARIES, 'desktop-helper-macos');
    try { chmodSync(helper, 0o755); } catch {}
    return { cmd: helper, args: [], cwd: dirname(helper) };
  }
  return { cmd: 'python3', args: [join(SOURCES, 'linux', 'desktop_helper.py')], cwd: join(SOURCES, 'linux') };
}

const run = (cmd, args, opts = {}) => new Promise(resolve => {
  const p = spawn(cmd, args, { windowsHide: true, ...opts });
  let err = '';
  p.stderr?.on('data', d => { err = (err + d).slice(-2000); });
  p.on('error', e => resolve({ code: -1, err: e.message }));
  p.on('exit', code => resolve({ code, err }));
});

export async function prepareHelpers() {
  if (PLATFORM !== 'win32' || existsSync(VENV_PYTHON)) return { ok: true };
  const made = await run('py', ['-3', '-m', 'venv', VENV]);
  if (made.code !== 0) return { ok: false, error: `Desktop control needs Python 3 (python.org): ${made.err.trim() || 'py launcher not found'}` };
  const installed = await run(VENV_PYTHON, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', join(SOURCES, 'windows', 'requirements.txt')]);
  return installed.code === 0 ? { ok: true } : { ok: false, error: `Could not install the desktop helper's packages: ${installed.err.trim().slice(-300)}` };
}

let child = null;
const pending = new Map();
let starting = null;

function start() {
  if (child) return Promise.resolve();
  starting ||= new Promise((resolve, reject) => {
    const { cmd, args, cwd } = command();
    const proc = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let stderr = '';
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    proc.once('spawn', () => { child = proc; resolve(); });
    proc.once('error', error => { child = null; reject(new Error(`the desktop helper could not start (${error.message})`)); });
    proc.on('exit', code => {
      child = null;
      for (const p of pending.values()) p.reject(new Error(`the desktop helper stopped (code ${code}). ${stderr.slice(-300)}`));
      pending.clear();
    });
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event) return;
      const p = pending.get(String(message.id));
      if (!p) return;
      pending.delete(String(message.id));
      if (message.ok) p.resolve(message.result);
      else p.reject(new Error(message.error?.message || 'the desktop helper could not do that'));
    });
  }).finally(() => { starting = null; });
  return starting;
}

async function call(method, params = {}, timeout = 20000) {
  await start();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const native = (method, params = {}, timeout) => call('native.call', { native_method: method, native_params: params, allowed_roots: [] }, timeout);

export function stop() { try { child?.kill(); } catch {} child = null; }

const OWN = /^(OpenSpawn Bot|Taskbar|Program Manager|Start|Search|Windows Input Experience|NVIDIA GeForce Overlay|Notification Center|Desktop|)$/i;
export async function listWindows() {
  const r = await native('windows.list', { visibleOnly: true });
  return (r.windows || r || []).filter(w => w.title && w.visible !== false && !OWN.test(w.title.trim()));
}

let target = null;
export async function focusWindow(title) {
  const windows = await listWindows();
  const want = title.toLowerCase();
  const match = windows.find(w => w.title.toLowerCase() === want) || windows.find(w => w.title.toLowerCase().includes(want)) || windows.find(w => want.split(/\s+/).every(p => w.title.toLowerCase().includes(p)));
  if (!match) throw new Error(`no open window titled like "${title}". Open windows: ${windows.slice(0, 12).map(w => w.title).join(' | ')}`);
  await native('windows.focus', { handle: match.handle, title: match.title, processId: match.processId });
  target = match;
  return { focused: match.title };
}
async function current() {
  if (PLATFORM !== 'win32') {
    try { const f = await native('windows.foreground', {}, 8000); if (f?.title && !OWN.test(f.title)) return { title: f.title, processId: f.processId, handle: f.handle }; } catch {}
  }
  if (target) {
    const still = (await listWindows()).find(w => w.handle === target.handle);
    if (still) return still;
  }
  const windows = await listWindows();
  if (!windows.length) throw new Error('no application window is open');
  return windows[0];
}

const INTERACTIVE = /^(Button|Edit|Hyperlink|Link|MenuItem|CheckBox|ComboBox|ListItem|TabItem|RadioButton|SplitButton|TreeItem|MenuBarItem|Slider|Spinner|Document|text field|button|link|push button|toggle button|check box|combo box|menu item|page tab|list item|entry|AXButton|AXTextField|AXLink|AXMenuItem|AXCheckBox|AXPopUpButton|AXTextArea|AXRadioButton|AXTab)$/i;
const TEXTUAL = /^(Text|Static|Document|Edit|label|paragraph|heading|static|AXStaticText|AXHeading|AXTextArea)$/i;

export async function readForeground() {
  const win = await current();
  const snap = await native('uia.snapshot', { window: { handle: win.handle, title: win.title, processId: win.processId }, maxDepth: 25, maxElements: 1500 }, 25000);
  const elements = snap.elements || [];
  const seen = new Set();
  const text = [];
  for (const e of elements) {
    const words = [e.name, e.value].filter(Boolean).join(' — ').trim();
    if (!words || e.offscreen || seen.has(words)) continue;
    if (TEXTUAL.test(e.controlType) || e.value) { seen.add(words); text.push(words); }
  }
  const controls = elements.filter(e => INTERACTIVE.test(e.controlType) && (e.name || e.value) && !e.offscreen && e.enabled !== false)
    .map(e => ({ name: e.name || e.value, type: e.controlType, ...(e.value && e.value !== e.name ? { value: String(e.value).slice(0, 120) } : {}) }));
  return { window: win.title, text: text.join('\n').slice(0, 30000), controls: controls.slice(0, 150), truncated: Boolean(snap.truncated) };
}

export async function clickByName(name) {
  const win = await current();
  const window = { handle: win.handle, title: win.title, processId: win.processId };
  for (const selector of [{ name }, { nameContains: name }]) {
    try { const r = await native('uia.invoke', { window, selector, timeoutMs: 4000 }, 12000); if (r) return { clicked: name, window: win.title }; } catch {}
  }
  const found = await native('uia.query', { window, selector: { nameContains: name }, timeoutMs: 3000 }, 10000).catch(() => null);
  const el = found?.elements?.find(e => e.bounds?.width > 0);
  if (!el) throw new Error(`nothing called "${name}" in "${win.title}". Call read_screen and copy a control name it lists.`);
  await native('input.click', { x: Math.round(el.bounds.x + el.bounds.width / 2), y: Math.round(el.bounds.y + el.bounds.height / 2) });
  return { clicked: el.name, window: win.title, by: 'coordinates' };
}

export async function typeByName(text, into) {
  const win = await current();
  if (into) {
    const window = { handle: win.handle, title: win.title, processId: win.processId };
    for (const selector of [{ name: into }, { nameContains: into }]) {
      try { await native('uia.setValue', { window, selector, value: text, timeoutMs: 4000 }, 12000); return { typed: text.length + ' characters', into, window: win.title }; } catch {}
    }
    await clickByName(into);
  } else if (PLATFORM === 'win32') {
    await native('windows.focus', { handle: win.handle, title: win.title });
  }
  await native('input.sendText', { text });
  return { typed: text.length + ' characters', window: win.title };
}

function keyFor(key) {
  const parts = key.split('+').map(p => p.trim()).filter(Boolean);
  if (PLATFORM !== 'win32') return parts.map(p => p.toLowerCase().replace(/^(cmd|command)$/, 'super').replace(/^option$/, 'alt').replace(/^esc$/, 'escape').replace(/^return$/, 'enter')).join('+');
  const named = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', insert: '{INSERT}' };
  const mods = { ctrl: '^', control: '^', alt: '%', shift: '+', win: '{VK_LWIN down}', cmd: '^', meta: '{VK_LWIN down}' };
  let prefix = '', suffix = '';
  for (const m of parts.slice(0, -1)) { const k = m.toLowerCase(); if (k === 'win' || k === 'meta') { prefix += '{VK_LWIN down}'; suffix = '{VK_LWIN up}' + suffix; } else prefix += mods[k] || ''; }
  const last = parts.at(-1);
  const lk = last.toLowerCase();
  const body = named[lk] || (/^f\d{1,2}$/i.test(last) ? `{${last.toUpperCase()}}` : last.length === 1 ? last.toLowerCase() : `{${last.toUpperCase()}}`);
  return prefix + body + suffix;
}
export async function pressKey(key) {
  const win = await current();
  if (PLATFORM === 'win32') await native('windows.focus', { handle: win.handle, title: win.title }).catch(() => {});
  await native('input.sendKey', { key: keyFor(key) });
  return { pressed: key, window: win.title };
}
export async function scroll(delta) {
  const win = await current();
  if (PLATFORM === 'win32') await native('windows.focus', { handle: win.handle, title: win.title }).catch(() => {});
  await native('input.scroll', { delta: -delta });
  return { scrolled: delta > 0 ? 'down' : 'up', window: win.title };
}
export async function health() { try { return await call('health', {}, 15000); } catch (error) { return { error: error.message }; } }
