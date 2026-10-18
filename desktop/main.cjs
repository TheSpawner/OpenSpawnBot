const { app, BrowserWindow, shell, Menu, nativeImage } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const DATA = process.env.ZK_DATA || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'OpenSpawn Bot')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'OpenSpawn Bot')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'openspawn-bot'));
const RUNTIME = process.env.ZK_RUNTIME || (!app.isPackaged ? path.join(ROOT, 'runtime') : process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenSpawn Bot', 'runtime')
  : path.join(DATA, 'runtime'));
app.setPath('userData', path.join(DATA, 'electron'));
const LOG = path.join(DATA, 'engine.log');
const PID_FILE = path.join(DATA, 'app.pid');
const ACK_FILE = path.join(DATA, 'app.ack');
let port = Number(process.env.ZK_PORT || readPort());
const url = () => `http://127.0.0.1:${port}`;
let engine = null;
let win = null;
let engineExit = null;

function readPort() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).port || 7777; } catch { return 7777; }
}

function ping(p = port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${p}/api/ping`, { timeout: 800 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function portFree(p) {
  return new Promise(resolve => {
    const probe = net.createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
    probe.listen(p, '127.0.0.1');
  });
}

const logTail = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').slice(-18).join('\n').trim(); } catch { return ''; } };
const status = text => win?.webContents.executeJavaScript(`window.setStatus && setStatus(${JSON.stringify(text)})`).catch(() => {});
const progress = (value, next) => win?.webContents.executeJavaScript(`window.setProgress && setProgress(${Number(value)}, ${next == null ? 'undefined' : Number(next)})`).catch(() => {});

async function startEngine() {
  if (await ping()) { progress(0.8); return 'attached'; }
  if (!(await portFree(port))) {
    for (let p = port + 1; p < port + 30; p++) if (await portFree(p)) { port = p; break; }
  }
  const log = fs.openSync(LOG, 'w');
  engineExit = null;
  engine = spawn(process.execPath, [path.join(ROOT, 'engine', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZK_PORT: String(port), ZK_OWNER_PID: String(process.pid), ZK_DATA: DATA, ZK_RUNTIME: RUNTIME },
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  progress(0.15, 0.85);
  engine.on('exit', code => {
    engine = null;
    engineExit = code ?? 0;
    if (!app.isQuitting && win && !win.webContents.getURL().startsWith('file:')) showFailure(`The engine stopped unexpectedly (code ${code}).`);
  });
  for (let i = 0; i < 240; i++) {
    if (await ping()) return 'started';
    if (engineExit !== null) throw new Error(`The engine stopped while starting (code ${engineExit}).`);
    if (i === 8) status('Starting the engine…');
    if (i === 60) status('Taking a little longer than usual…');
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('The engine did not answer within a minute.');
}

function showFailure(message) {
  if (!win) return;
  const show = () => win.webContents.executeJavaScript(`window.showError && showError(${JSON.stringify(message)}, ${JSON.stringify(logTail())})`).catch(() => {});
  if (win.webContents.getURL().startsWith('file:')) show();
  else win.loadFile(path.join(ROOT, 'ui', 'splash.html')).then(show);
  if (!win.isVisible()) win.show();
}

function createWindow() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'ui', 'logo.png'));
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 520, show: false, icon,
    title: 'OpenSpawn Bot', backgroundColor: '#fbfbfc', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url: target }) => { if (/^https?:/i.test(target)) shell.openExternal(target); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('openspawn://')) {
      event.preventDefault();
      if (target.startsWith('openspawn://retry')) { app.isQuitting = true; stopEngine(); app.relaunch(); app.exit(0); }
      if (target.startsWith('openspawn://log')) shell.openPath(LOG);
      return;
    }
    if (!target.startsWith(url())) { event.preventDefault(); if (/^https?:/i.test(target)) shell.openExternal(target); }
  });
  win.on('closed', () => { win = null; });
  return win.loadFile(path.join(ROOT, 'ui', 'splash.html'));
}

const getState = () => new Promise(resolve => {
  const req = http.get(`${url()}/api/state`, { timeout: 4000 }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});
async function firstRunSetup() {
  const mb = n => `${Math.round(n / 1e6).toLocaleString('en-US')} MB`;
  for (;;) {
    const s = await getState();
    const setup = s?.health?.setup;
    if (!setup || setup.done) return;
    if (setup.error) throw new Error(`The download stopped: ${setup.error}. Check the internet connection and try again.`);
    const share = setup.total ? setup.received / setup.total : 0;
    status(`${mb(setup.received)} of ${mb(setup.total)}`);
    win?.webContents.executeJavaScript(`window.setDetail && setDetail(${JSON.stringify(`First-time setup: downloading ${setup.label}. This happens once.`)})`).catch(() => {});
    progress(0.12 + share * 0.84, 0.12 + share * 0.84 + 0.01);
    await new Promise(r => setTimeout(r, 400));
  }
}

function stopEngine() {
  if (!engine) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(engine.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(engine.pid, 'SIGTERM');
  } catch {}
}

function bringToFront() {
  if (!win) { createWindow().then(() => win.loadURL(url())); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function takeOverIfStuck() {
  const asked = Date.now();
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { if (Number(fs.readFileSync(ACK_FILE, 'utf8')) >= asked) return false; } catch {}
  }
  try {
    const stale = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (stale && stale !== process.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(stale), '/T', '/F'], { windowsHide: true });
      else process.kill(stale, 'SIGKILL');
    }
  } catch {}
  return true;
}

function ensureShortcuts() {
  if (app.isPackaged) return;
  try {
    if (process.platform === 'win32') {
      const options = { target: process.execPath, args: `"${ROOT}"`, cwd: ROOT, icon: path.join(ROOT, 'ui', 'icon.ico'), iconIndex: 0, appUserModelId: 'ai.openspawn.bot', description: 'OpenSpawn Bot' };
      shell.writeShortcutLink(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenSpawn Bot.lnk'), fs.existsSync(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenSpawn Bot.lnk')) ? 'replace' : 'create', options);
      const marker = path.join(DATA, 'desktop-shortcut');
      if (!fs.existsSync(marker)) {
        const link = path.join(app.getPath('desktop'), 'OpenSpawn Bot.lnk');
        if (shell.writeShortcutLink(link, fs.existsSync(link) ? 'replace' : 'create', options) && fs.existsSync(link)) fs.writeFileSync(marker, '');
      }
    } else if (process.platform === 'linux') {
      const dir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'openspawn-bot.desktop'), `[Desktop Entry]\nType=Application\nName=OpenSpawn Bot\nExec="${process.execPath}" "${ROOT}"\nIcon=${path.join(ROOT, 'ui', 'logo.png')}\nTerminal=false\nCategories=Utility;\n`);
    }
  } catch { }
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!app.requestSingleInstanceLock()) {
    if (await takeOverIfStuck()) { app.relaunch(); }
    app.exit(0);
    return;
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  app.on('second-instance', () => {
    try { fs.writeFileSync(ACK_FILE, String(Date.now())); } catch {}
    bringToFront();
  });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId('ai.openspawn.bot');
  ensureShortcuts();
  await createWindow();
  try {
    await startEngine();
    await firstRunSetup();
    status('Opening…');
    await progress(1);
    await new Promise(r => setTimeout(r, 850));
    await win?.loadURL(url());
  } catch (error) {
    showFailure(error.message);
  }
}

app.on('window-all-closed', () => app.quit());
let cleaned = false;
app.on('before-quit', event => {
  app.isQuitting = true;
  try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {}
  if (!engine || cleaned) return;
  event.preventDefault();
  cleaned = true;
  const req = http.request(`${url()}/api/quit`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url() }, timeout: 1500 });
  req.on('error', () => {}); req.end('{}');
  setTimeout(() => { stopEngine(); app.exit(0); }, 1200);
});

main();
