import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { DATA, sleep } from '../util.mjs';
import { PLATFORM, exec, shell, psQuote } from './platform.mjs';

const PROFILES = join(DATA, 'browser-profiles');
let browser = null;
let current = null;
const sessions = new Map();

const CHROMIUM = /chrome|chromium|msedge|brave|vivaldi|opera|thorium|yandex|iridium/i;
const brandOf = text => (String(text).match(/brave|msedge|edge|vivaldi|opera|chromium|chrome|thorium|yandex|iridium|firefox|librewolf|safari|arc/i)?.[0] || 'browser').toLowerCase().replace('msedge', 'edge');
const NAMES = { brave: 'Brave', edge: 'Edge', chrome: 'Chrome', chromium: 'Chromium', vivaldi: 'Vivaldi', opera: 'Opera', thorium: 'Thorium', yandex: 'Yandex', iridium: 'Iridium', firefox: 'Firefox', librewolf: 'LibreWolf', safari: 'Safari', arc: 'Arc' };
const nameOf = brand => NAMES[brand] || brand;

function candidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = process.env.LOCALAPPDATA || '';
  if (PLATFORM === 'win32') return [
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), join(local, 'Chromium', 'Application', 'chrome.exe'),
    join(local, 'Vivaldi', 'Application', 'vivaldi.exe')
  ];
  if (PLATFORM === 'darwin') return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi'].flatMap(n => [`/Applications/${n}.app/Contents/MacOS/${n}`, join(os.homedir(), 'Applications', `${n}.app`, 'Contents', 'MacOS', n)]);
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/chromium', '/usr/bin/vivaldi', '/usr/bin/vivaldi-stable'];
}

let detected;
async function defaultBrowser() {
  if (detected !== undefined) return detected;
  detected = null;
  try {
    if (PLATFORM === 'win32') {
      let progId = null;
      for (const scheme of ['https', 'http']) {
        const r = await exec('reg', ['query', `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`, '/v', 'ProgId'], { timeout: 5000 });
        progId = r.out.match(/ProgId\s+REG_SZ\s+(\S+)/i)?.[1];
        if (progId) break;
      }
      if (progId) {
        const r = await exec('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], { timeout: 5000 });
        const command = r.out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i)?.[1]?.trim() || '';
        const exe = (command.match(/^"([^"]+)"/)?.[1] || command.split(/\s+/)[0] || '').replace(/%([^%]+)%/g, (m, v) => process.env[v] || m);
        if (exe && existsSync(exe)) detected = { exe, argv: [], brand: brandOf(exe) };
        else detected = { exe: null, argv: [], brand: brandOf(progId) };
      }
    } else if (PLATFORM === 'darwin') {
      const r = await exec('defaults', ['read', join(os.homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure'), 'LSHandlers'], { timeout: 5000 });
      const block = r.out.split(/\},?\s*\{/).find(b => /LSHandlerURLScheme\s*=\s*"?https"?;/.test(b));
      const bundle = block?.match(/LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/)?.[1];
      if (bundle) {
        const app = (await exec('mdfind', [`kMDItemCFBundleIdentifier == '${bundle}'`], { timeout: 5000 })).out.split('\n').find(p => p.endsWith('.app'));
        const bin = app && (await exec('defaults', ['read', join(app, 'Contents', 'Info'), 'CFBundleExecutable'], { timeout: 5000 })).out.trim();
        const exe = app && bin ? join(app, 'Contents', 'MacOS', bin) : null;
        detected = { exe: exe && existsSync(exe) ? exe : null, argv: [], brand: brandOf(`${bundle} ${app || ''}`) };
      }
    } else {
      const desktop = (await exec('xdg-settings', ['get', 'default-web-browser'], { timeout: 5000 })).out.trim();
      const dirs = [join(os.homedir(), '.local', 'share', 'applications'), '/usr/share/applications', '/usr/local/share/applications', '/var/lib/flatpak/exports/share/applications', join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), '/var/lib/snapd/desktop/applications'];
      const file = desktop && dirs.map(d => join(d, desktop)).find(f => existsSync(f));
      const line = file && readFileSync(file, 'utf8').match(/^Exec=(.+)$/m)?.[1];
      if (line) {
        const words = line.replace(/\s%[a-zA-Z]/g, '').match(/"[^"]*"|\S+/g).map(w => w.replace(/^"|"$/g, '')).filter(w => !/^\w+=/.test(w) && w !== 'env');
        let [exe, ...argv] = words;
        if (exe && !exe.startsWith('/')) exe = (await exec('which', [exe], { timeout: 4000 })).out.trim() || exe;
        detected = { exe: exe && existsSync(exe) ? exe : null, argv, brand: brandOf(`${desktop} ${line}`) };
      }
    }
  } catch { detected = null; }
  return detected;
}

async function choices() {
  if (process.env.ZK_BROWSER) return [{ exe: process.env.ZK_BROWSER, argv: [], brand: brandOf(process.env.ZK_BROWSER), isDefault: false }];
  const def = await defaultBrowser();
  const list = [];
  if (def?.exe && CHROMIUM.test(`${def.brand} ${def.exe} ${def.argv.join(' ')}`)) list.push({ ...def, isDefault: true });
  for (const exe of candidates()) if (existsSync(exe) && !list.some(c => c.exe?.toLowerCase() === exe.toLowerCase())) list.push({ exe, argv: [], brand: brandOf(exe), isDefault: false });
  return list;
}
export const browserPath = () => process.env.ZK_BROWSER || browser?.exe || (detected?.exe && CHROMIUM.test(detected.exe) ? detected.exe : null) || candidates().find(p => existsSync(p)) || null;

let described = null;
export async function describe() {
  if (described) return described;
  const [first] = await choices();
  const def = await defaultBrowser();
  described = first ? { name: nameOf(first.brand), isDefault: Boolean(first.isDefault), defaultName: def ? nameOf(def.brand) : null } : { name: null, isDefault: false, defaultName: def ? nameOf(def.brand) : null };
  return described;
}

const LAUNCH = 2;
const launchedWith = profile => { try { return JSON.parse(readFileSync(join(profile, 'openspawn-launch.json'), 'utf8')).version; } catch { return 0; } };
const PORTS = { brave: 9301, chrome: 9302, edge: 9303, chromium: 9304, vivaldi: 9305, opera: 9306, thorium: 9307, yandex: 9308, iridium: 9309 };
const portFor = brand => PORTS[brand] || 9310;
const alive = async port => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) })).ok; } catch { return false; } };
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function ours() {
  try {
    if (PLATFORM === 'win32') {
      const r = await shell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psQuote(PROFILES)}) -and -not $_.CommandLine.Contains('--type=') } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`, { timeout: 20000 });
      return r.out.split(/\r?\n/).filter(l => l.includes('|')).map(l => ({ pid: Number(l.slice(0, l.indexOf('|'))), cmd: l.slice(l.indexOf('|') + 1) }));
    }
    const r = await exec('ps', ['-axo', 'pid=,command='], { timeout: 8000 });
    return r.out.split('\n').map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(m => m && m[2].includes(PROFILES) && !m[2].includes('--type=')).map(m => ({ pid: Number(m[1]), cmd: m[2] }));
  } catch { return []; }
}
const usesProfile = (cmd, profile) => new RegExp(`${escapeRe(profile)}(?:["'\\s]|$)`).test(cmd);
async function kill(pid) {
  if (PLATFORM === 'win32') await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 });
  else try { process.kill(pid, 'SIGTERM'); } catch {}
}
async function closeOthers(profile) { for (const p of await ours()) if (!usesProfile(p.cmd, profile)) await kill(p.pid); }

async function launch() {
  if (browser) {
    if (await alive(browser.port)) return browser;
    browser = null; current = null; sessions.clear();
  }
  const list = await choices();
  if (!list.length) throw new Error('no Chromium-based browser found (install Chrome, Edge, Brave or Chromium)');
  for (const choice of list) {
    const profile = join(PROFILES, choice.brand), fixed = portFor(choice.brand);
    mkdirSync(profile, { recursive: true });
    const portFile = join(profile, 'DevToolsActivePort');
    const made = port => ({ port: Number(port), exe: choice.exe, brand: choice.brand, name: nameOf(choice.brand), isDefault: choice.isDefault, profile });
    let port = null;
    try { const [p] = readFileSync(portFile, 'utf8').split('\n'); if (p && await alive(p)) port = p; } catch {}
    if (!port && await alive(fixed)) port = fixed;
    if (port && launchedWith(profile) === LAUNCH) { browser = made(port); await closeOthers(profile); return browser; }
    const stale = (await ours()).filter(p => usesProfile(p.cmd, profile));
    for (const p of stale) await kill(p.pid);
    if (stale.length) await sleep(1000);
    try { writeFileSync(portFile, ''); } catch {}
    const args = [...choice.argv, `--user-data-dir=${profile}`, `--remote-debugging-port=${fixed}`, '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--hide-crash-restore-bubble', '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate,CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-media-suspend', '--window-size=1280,900', ...(PLATFORM === 'linux' ? ['--password-store=basic'] : []), 'about:blank'];
    const proc = spawn(choice.exe, args, { detached: true, stdio: 'ignore' });
    proc.on('error', () => {});
    proc.unref();
    for (let i = 0; i < 100; i++) {
      await sleep(150);
      if (await alive(fixed)) { try { writeFileSync(join(profile, 'openspawn-launch.json'), JSON.stringify({ version: LAUNCH })); } catch {} browser = made(fixed); await closeOthers(profile); return browser; }
    }
    try { proc.kill(); } catch {}
  }
  throw new Error('the browser did not open its debugging port');
}
export const which = () => browser ? { name: browser.name, isDefault: browser.isDefault } : null;

const api = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${browser.port}${path}`, { method, signal: AbortSignal.timeout(5000) })).json().catch(() => null);
async function pages() { await launch(); return ((await api('/json/list')) || []).filter(t => t.type === 'page' && !t.url.startsWith('devtools://')); }

async function connect(target) {
  if (sessions.has(target.id)) return sessions.get(target.id);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const session = { id: target.id, ws, seq: 0, pending: new Map(), console: [], network: new Map(), inflight: 0, lastNetwork: Date.now() };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not attach to the page')); });
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && session.pending.has(m.id)) { const p = session.pending.get(m.id); session.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') session.console.push({ level: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500) });
    if (m.method === 'Runtime.exceptionThrown') session.console.push({ level: 'error', text: (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 500) });
    if (m.method === 'Network.requestWillBeSent') { session.network.set(m.params.requestId, { method: m.params.request.method, url: m.params.request.url.slice(0, 300), status: null }); session.inflight++; session.lastNetwork = Date.now(); }
    if (m.method === 'Network.responseReceived') { const r = session.network.get(m.params.requestId); if (r) r.status = m.params.response.status; }
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { session.inflight = Math.max(0, session.inflight - 1); session.lastNetwork = Date.now(); const r = session.network.get(m.params.requestId); if (r && m.method === 'Network.loadingFailed') r.failed = m.params.errorText; }
    if (session.console.length > 300) session.console.splice(0, 100);
    if (session.network.size > 600) session.network.delete(session.network.keys().next().value);
  };
  ws.onclose = () => { sessions.delete(target.id); if (current === session) current = null; };
  session.send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++session.seq; session.pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (session.pending.has(id)) { session.pending.delete(id); reject(new Error(`${method} timed out`)); } }, 30000); });
  await session.send('Runtime.enable'); await session.send('Network.enable'); await session.send('Page.enable');
  sessions.set(target.id, session);
  return session;
}

async function page() {
  if (current && sessions.has(current.id)) return current;
  const list = await pages();
  const target = list.find(t => /^https?:/.test(t.url)) || list[0] || await api('/json/new?about:blank', 'PUT');
  for (const t of list) if (t.id !== target.id && t.url === 'about:blank') await api(`/json/close/${t.id}`).catch(() => {});
  current = await connect(target);
  await front(current);
  return current;
}
export async function focus() { const s = await page(); await front(s); return here(s); }

function pageHelper() {
  if (window.__zk && window.__zk.v === 7) return;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const roots = () => { const out = [document]; const walk = r => { for (const el of r.querySelectorAll('*')) if (el.shadowRoot) { out.push(el.shadowRoot); walk(el.shadowRoot); } }; walk(document); return out; };
  const all = sel => roots().flatMap(r => [...r.querySelectorAll(sel)]);
  const visible = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const textOf = el => {
    const by = el.getAttribute('aria-labelledby');
    const labelled = by ? by.split(/\s+/).map(id => (el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : document.getElementById(id))?.innerText || '').join(' ') : '';
    return clean(el.getAttribute('aria-label') || labelled || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.getAttribute('alt') || (el.tagName === 'INPUT' && /button|submit/i.test(el.type) ? el.value : '') || el.getAttribute('name') || '').slice(0, 120);
  };
  let next = Number(document.documentElement.dataset.zkNext || 1);
  const ref = el => { if (!el.dataset.zkRef) { el.dataset.zkRef = 'e' + (next++); document.documentElement.dataset.zkNext = next; } return el.dataset.zkRef; };
  const byRef = r => all('[data-zk-ref="' + String(r).replace(/"/g, '') + '"]')[0] || null;
  const up = n => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const region = el => {
    for (let n = el; n && n.getAttribute; n = up(n)) {
      const t = n.tagName.toLowerCase(), role = n.getAttribute('role');
      if (t === 'dialog' || role === 'dialog' || role === 'alertdialog' || n.getAttribute('aria-modal') === 'true') return 'dialog';
      if (t === 'header' || role === 'banner') return 'header';
      if (t === 'nav' || role === 'navigation') return 'nav';
      if (t === 'footer' || role === 'contentinfo') return 'footer';
      if (t === 'aside' || role === 'complementary') return 'aside';
      if (t === 'main' || role === 'main') return 'main';
    }
    return '';
  };
  const TYPEABLE = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=file]):not([type=range]):not([type=color]),textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]';
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const describeEl = el => {
    const tag = el.tagName.toLowerCase();
    const item = { ref: ref(el), role: el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag), name: textOf(el) };
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && el.value) item.value = String(el.value).slice(0, 80);
    if (el.checked) item.checked = true;
    if (el.disabled) item.disabled = true;
    const where = region(el); if (where) item.region = where;
    return item;
  };
  const snapshot = () => {
    const elements = [];
    for (const el of all(INTERACTIVE)) { if (!visible(el)) continue; elements.push(describeEl(el)); if (elements.length >= 250) break; }
    return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 7000), elements };
  };
  const hitTest = el => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) return { x, y, covered: null, offscreen: true };
    let top = document.elementFromPoint(x, y);
    while (top && top.shadowRoot) { const inner = top.shadowRoot.elementFromPoint(x, y); if (!inner || inner === top) break; top = inner; }
    let ok = !top || top === el;
    for (let n = top; n && !ok; n = up(n)) if (n === el) ok = true;
    for (let n = el; n && !ok; n = up(n)) if (n === top) ok = true;
    return { x, y, covered: ok ? null : clean(textOf(top) || top.tagName.toLowerCase()).slice(0, 80) };
  };
  const activeDeep = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  const valueOf = el => el ? ('value' in el && el.tagName !== 'BUTTON' ? String(el.value) : clean(el.innerText)) : null;
  const searchScore = el => {
    if (!visible(el) || el.disabled || el.readOnly) return -1;
    const type = (el.getAttribute('type') || '').toLowerCase(), role = (el.getAttribute('role') || '').toLowerCase();
    const name = (el.getAttribute('name') || '').toLowerCase(), id = (el.id || '').toLowerCase();
    const label = (textOf(el) + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
    let s = 0;
    if (type === 'search') s += 5;
    if (role === 'searchbox') s += 4;
    if (role === 'combobox') s += 1;
    if (/(^|[\W_])(q|query|search|search_query|searchterm|search_term|keywords?|k|s|term|field-keywords|text|p)([\W_]|$)/.test(name)) s += 3;
    if (/search|query/.test(id)) s += 2;
    if (/search|find|look ?up|what are you looking for|buscar|suche|rechercher|cerca/.test(label)) s += 4;
    if (el.closest('form[role=search],[role=search],search') || (el.getRootNode().host && el.getRootNode().host.closest && el.getRootNode().host.closest('form[role=search],[role=search],search'))) s += 3;
    const action = el.form && el.form.getAttribute('action') || '';
    if (/search|\/s(\?|$)|results|query/i.test(action)) s += 2;
    const where = region(el);
    if (where === 'header' || where === 'nav') s += 1;
    if (where === 'footer') s -= 3;
    if (['email', 'password', 'tel', 'number', 'date', 'url'].includes(type) || /mail|password|user|login|zip|postal|phone|coupon|promo/.test(name + ' ' + label)) s -= 8;
    const r = el.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) s += 1;
    return s;
  };
  const searchFields = () => all(TYPEABLE).map(el => ({ el, s: searchScore(el) })).filter(x => x.s >= 3).sort((a, b) => b.s - a.s).slice(0, 3).map(x => ({ ref: ref(x.el), score: x.s, label: textOf(x.el) || x.el.getAttribute('name') || 'search' }));
  const searchToggle = () => { const el = all('button,[role=button],a,summary,label').filter(visible).find(el => /(^|\W)search(\W|$)|type \/ to search/i.test(textOf(el)) && !/advanced|settings|history|clear|voice|image|camera|by voice/i.test(textOf(el))); return el ? ref(el) : null; };
  const NO = /^(reject( all| all cookies| non-essential( cookies)?| optional cookies| additional cookies)?|decline( all| optional cookies| cookies)?|refuse( all)?|deny( all)?|only (necessary|essential|required)( cookies)?|(allow |accept )?(only )?(necessary|essential|required) (cookies )?only|use (only )?(necessary|essential) cookies( only)?|continue without (accepting|agreeing)|i do not agree|disagree|tout refuser|refuser|alle ablehnen|ablehnen|nur notwendige( cookies)?|rechazar( todo| todas)?|rifiuta( tutto)?|weigeren|alles weigeren|odrzuć wszystkie)$/i;
  const consent = () => all('button,[role=button],a,input[type=button],input[type=submit]').filter(visible).filter(el => NO.test(clean(el.innerText || el.value || el.getAttribute('aria-label')).replace(/[.!]$/, ''))).slice(0, 3).map(el => ({ ref: ref(el), label: clean(el.innerText || el.value || el.getAttribute('aria-label')) }));
  const site = h => { try { return new URL(h).hostname.split('.').slice(-2).join('.'); } catch (e) { return ''; } };
  const results = query => {
    const words = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
    const byHref = new Map();
    const ads = [];
    for (const el of all('span,div,p,small,b,strong,badge-shape,[class*=badge],[class*=label]')) {
      if (el.childElementCount || !/^(sponsored|ad|ads|promoted|advertisement|anzeige|publicité|patrocinado)$/i.test(clean(el.textContent))) continue;
      let box = el.parentElement;
      for (let i = 0; box && i < 12 && !box.querySelector('a[href]'); i++) box = box.parentElement;
      if (box && box !== document.body) ads.push(box);
    }
    for (const a of all('a[href]')) {
      if (!visible(a) || ads.some(box => box.contains(a))) continue;
      const where = region(a);
      if (where === 'header' || where === 'nav' || where === 'footer' || where === 'dialog') continue;
      const href = a.href, key = String(href).split('#')[0];
      if (!/^https?:/.test(href) || /\/(pagead|aclk|adclick|ads?)\b|doubleclick|googleadservices/i.test(href)) continue;
      const text = clean(a.innerText || a.getAttribute('title') || a.getAttribute('aria-label')).replace(/^(?:\d{1,2}:)?\d{1,2}:\d{2}\s*/, '').replace(/\b(now playing|watch later|add to queue)\b/gi, '').split(/\s+(?:·|\|)\s+/)[0].trim();
      const r = a.getBoundingClientRect(), low = text.toLowerCase();
      const hit = words.filter(w => low.includes(w)).length;
      const prev = byHref.get(key);
      const good = text.length >= 12 && text.length <= 220 && key !== String(location.href).split('#')[0]
        && !/\bgo to (?:the )?channel\b|^(skip to|jump to|see (more|all)|show (more|all)|view (more|all)|load more|more results|next page|previous page|sign in|log in|back to top)\b/i.test(text);
      if (!prev) { byHref.set(key, { ref: ref(a), text: good ? text.slice(0, 160) : '', href, top: Math.round(r.top + scrollY), left: Math.round(r.left), hit, media: /\/(watch|video|videos|track|song|album|playlist|episode|listen|clip)\b|[?&]v=/i.test(href) }); continue; }
      if (good && (hit > prev.hit || (hit === prev.hit && text.length > prev.text.length))) Object.assign(prev, { ref: ref(a), text: text.slice(0, 160), hit });
      if (byHref.size >= 120) break;
    }
    let out = [...byHref.values()].filter(x => x.text);
    const home = site(location.href), local = out.filter(x => site(x.href) === home);
    if (local.length >= 3) out = local;
    return out.sort((x, y) => (Number(y.hit > 0) - Number(x.hit > 0)) || (x.top - y.top) || (x.left - y.left)).slice(0, 60);
  };
  const humanCheck = () => {
    const u = location.href, body = clean(document.body ? document.body.innerText : '').slice(0, 3000);
    if (all('iframe[src*="captcha"],iframe[src*="challenges.cloudflare.com"],iframe[title*="challenge" i],#challenge-form,#cf-challenge-running,.g-recaptcha,.h-captcha,[id*="captcha" i],form[action*="captcha" i]').some(visible)) return 'a captcha';
    if (/\/(checkpoint|captcha|challenge|sorry|cdn-cgi\/challenge|blocked|verify)(\/|\?|$)/i.test(new URL(u).pathname + (new URL(u).search ? '?' : ''))) return 'a verification page';
    if (body.length < 1500 && /verify (that )?you are (a )?human|are you a robot|not a robot|unusual traffic|press (and|&) hold|checking your browser|confirm you.re not a bot|continue shopping/i.test(body)) return 'a verification page';
    return null;
  };
  const mediaState = () => all('video,audio').filter(m => m.currentSrc || m.getBoundingClientRect().width > 40).map(m => ({ playing: !m.paused && !m.ended && m.readyState > 2, time: Math.round(m.currentTime * 10) / 10, width: Math.round(m.getBoundingClientRect().width) }));
  const playMedia = () => { const list = all('video,audio').filter(m => m.currentSrc || m.getBoundingClientRect().width > 40).sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width); for (const m of list) { try { const p = m.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} } return list.length; };
  let changes = 0, observer = null;
  const watch = () => { changes = 0; if (observer) observer.disconnect(); observer = new MutationObserver(list => { changes += list.length; }); observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); return true; };
  window.__zk = { v: 7, clean, all, visible, textOf, ref, byRef, region, snapshot, describe: describeEl, hitTest, activeDeep, valueOf, searchFields, searchToggle, consent, results, humanCheck, mediaState, playMedia, watch, changes: () => changes, TYPEABLE, INTERACTIVE };
}
const HELPER = `(${pageHelper.toString()})();\n`;

async function evaluate(expression, s) {
  const session = s || await page();
  const r = await session.send('Runtime.evaluate', { expression: HELPER + expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'script error on the page');
  return r.result.value;
}
const call = (s, fn, ...args) => evaluate(`window.__zk.${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`, s);
async function settle(session, ms = 8000) {
  const until = Date.now() + ms, started = Date.now();
  while (Date.now() < until) {
    const state = await evaluate('document.readyState', session).catch(() => 'loading');
    if (state === 'complete' || (state === 'interactive' && Date.now() - started > 2500)) break;
    await sleep(150);
  }
  await sleep(250);
}
const here = s => evaluate('({ url: location.href, title: document.title })', s);
const isErrorPage = p => /^chrome-error:|^about:neterror|^edge-error:/i.test(p.url) || /^(this site can.t be reached|this page isn.t working|your connection is not private)/i.test(p.title || '');

export async function read() { return evaluate('window.__zk.snapshot()'); }
export async function text(max = 40000) { return evaluate(`({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${Number(max) || 40000}) })`); }
export async function find(query) {
  const snap = await read();
  const q = String(query).toLowerCase();
  return { url: snap.url, matches: snap.elements.filter(e => `${e.name} ${e.value || ''} ${e.role}`.toLowerCase().includes(q)).slice(0, 30) };
}
export async function where() { const s = await page(); return here(s); }
export async function ready() { const s = await page(); await settle(s, 10000); return here(s); }

async function front(s) {
  await api(`/json/activate/${s.id}`);
  await s.send('Page.bringToFront').catch(() => {});
  if (await evaluate('document.visibilityState', s).catch(() => 'visible') === 'hidden') {
    try {
      const { windowId } = await s.send('Browser.getWindowForTarget', { targetId: s.id });
      await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    } catch {}
  }
}
export async function dismissConsent(s) {
  s ||= await page();
  const declined = [];
  for (let round = 0; round < 2; round++) {
    const buttons = await call(s, 'consent').catch(() => []);
    if (!buttons.length) break;
    const b = buttons[0];
    try { await clickAt(s, b.ref); declined.push(b.label); } catch { break; }
    await sleep(600); await settle(s, 5000);
  }
  return declined;
}

export async function open(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`"${url}" is not a full http(s) address`);
  const session = await page();
  await session.send('Page.navigate', { url });
  await settle(session);
  await front(session);
  const declined = await dismissConsent(session);
  const t = await here(session);
  if (isErrorPage(t)) throw new Error(`the page did not load (${t.title || t.url})`);
  return { opened: t.url, title: t.title, ...(declined.length ? { declinedCookies: declined[0] } : {}), browser: `${browser.name}, its own profile`, next: 'Read the page (browser_read) before clicking or typing.' };
}
export async function back() { const s = await page(); await evaluate('history.back()', s); await settle(s); return here(s); }
export async function tabs() { return (await pages()).map(t => ({ tabId: t.id, title: t.title, url: t.url, active: t.id === current?.id })); }
export async function openTab(url) { await launch(); const t = await api(`/json/new?${encodeURI(url)}`, 'PUT'); current = await connect(t); await settle(current); await front(current); return { tabId: t.id, opened: url }; }
export async function switchTab(tabId) { const t = (await pages()).find(p => p.id === tabId); if (!t) throw new Error(`no tab ${tabId}`); current = await connect(t); await front(current); return { switched: t.title }; }
export async function closeTab(tabId) { await api(`/json/close/${tabId}`); if (current?.id === tabId) current = null; return { closed: tabId }; }

async function box(ref, session) {
  const r = await evaluate(`(() => { const el = window.__zk.byRef(${JSON.stringify(String(ref))}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const hit = window.__zk.hitTest(el); return { ...hit, label: window.__zk.textOf(el).slice(0, 80), tag: el.tagName.toLowerCase(), type: el.type || '', editable: el.isContentEditable }; })()`, session);
  if (!r) throw new Error(`no element ${ref} on this page any more. Read the page again and use a current ref.`);
  return r;
}
async function mouse(session, type, x, y, button = 'left', clickCount = 1) { await session.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount }); }
async function clickAt(s, ref, { button = 'left', clickCount = 1 } = {}) {
  let b = await box(ref, s);
  if (b.covered) { await dismissConsent(s).catch(() => []); await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {}); b = await box(ref, s); }
  if (b.covered) throw new Error(`"${b.label || ref}" is covered by "${b.covered}"`);
  await mouse(s, 'mouseMoved', b.x, b.y, 'none', 0);
  for (let i = 1; i <= clickCount; i++) { await mouse(s, 'mousePressed', b.x, b.y, button, i); await mouse(s, 'mouseReleased', b.x, b.y, button, i); }
  return b;
}
export async function click(ref, { button = 'left', clickCount = 1 } = {}) {
  const s = await page();
  const before = new Set((await pages()).map(p => p.id));
  await call(s, 'watch').catch(() => {});
  const startUrl = (await here(s)).url;
  const b = await clickAt(s, ref, { button, clickCount });
  await sleep(400);
  await settle(s, 4000);
  const fresh = (await pages()).find(p => !before.has(p.id));
  if (fresh) { current = await connect(fresh); await settle(current); await front(current); }
  const now = await here(current || s);
  const changed = fresh ? 'opened a new tab' : now.url !== startUrl ? 'the page changed' : (await call(s, 'changes').catch(() => 0)) > 0 ? 'the page updated' : null;
  return { clicked: ref, label: b.label, url: now.url, title: now.title, effect: changed || 'nothing visibly changed' };
}
export async function hover(ref) { const s = await page(); const b = await box(ref, s); await mouse(s, 'mouseMoved', b.x, b.y, 'none', 0); await sleep(300); return { hovered: ref, label: b.label }; }
export async function drag(fromRef, toRef) {
  const s = await page(); const a = await box(fromRef, s), b = await box(toRef, s);
  await mouse(s, 'mouseMoved', a.x, a.y, 'none', 0); await mouse(s, 'mousePressed', a.x, a.y);
  for (let i = 1; i <= 8; i++) await mouse(s, 'mouseMoved', a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8, 'left', 0);
  await mouse(s, 'mouseReleased', b.x, b.y); await sleep(300);
  return { dragged: fromRef, onto: toRef };
}

const same = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
async function pressKey(s, key) {
  const KEYS = { Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], PageDown: [34, 'PageDown'], PageUp: [33, 'PageUp'], Home: [36, 'Home'], End: [35, 'End'], Space: [32, 'Space', ' '] };
  const name = Object.keys(KEYS).find(k => k.toLowerCase() === String(key).toLowerCase().replace(/^(up|down|left|right)$/, 'arrow$1').replace(/^esc$/, 'escape').replace(/^return$/, 'enter')) || key;
  const [code, keyName, textValue] = KEYS[name] || [String(key).toUpperCase().charCodeAt(0), String(key), String(key).length === 1 ? String(key) : undefined];
  await s.send('Input.dispatchKeyEvent', { type: textValue ? 'keyDown' : 'rawKeyDown', key: keyName, code: keyName, windowsVirtualKeyCode: code, text: textValue });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: keyName, windowsVirtualKeyCode: code });
  return name;
}
export async function typeInto(ref, value, { submit = false, clear = true } = {}) {
  const s = await page();
  const b = await box(ref, s);
  const text = String(value);
  if (b.tag === 'select') {
    const ok = await evaluate(`(() => { const el = window.__zk.byRef(${JSON.stringify(ref)}); const want = ${JSON.stringify(text)}.toLowerCase(); const opt = [...el.options].find(o => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) || [...el.options].find(o => o.text.toLowerCase().includes(want)); if (!opt) return false; el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return opt.text; })()`, s);
    if (!ok) throw new Error(`no option "${text}" in that list`);
    return { selected: ok };
  }
  if (!b.covered) { await mouse(s, 'mousePressed', b.x, b.y); await mouse(s, 'mouseReleased', b.x, b.y); }
  const focus = () => evaluate(`(() => { const el = window.__zk.byRef(${JSON.stringify(ref)}); if (!el) return false; el.focus(); if (${clear}) { if (typeof el.select === 'function') el.select(); else { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } } return window.__zk.activeDeep() === el; })()`, s);
  const shown = () => evaluate(`window.__zk.valueOf(window.__zk.byRef(${JSON.stringify(ref)}))`, s);
  const fits = got => same(got, text) || (!clear && String(got).toLowerCase().includes(text.toLowerCase())) || (b.editable && String(got).toLowerCase().includes(text.toLowerCase()));
  if (!(await focus())) throw new Error(`could not put the cursor in "${b.label || ref}"${b.covered ? ` (covered by "${b.covered}")` : ''}`);
  if (text.length <= 80) for (const ch of text) { await s.send('Input.insertText', { text: ch }); await sleep(35); }
  else await s.send('Input.insertText', { text });
  let got = await shown(), how = 'typed';
  if (!fits(got)) {
    await focus();
    for (const ch of text) await s.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    got = await shown(); how = 'typed key by key';
  }
  if (!fits(got) && !b.editable) {
    await evaluate(`(() => { const el = window.__zk.byRef(${JSON.stringify(ref)}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`, s);
    got = await shown(); how = 'set';
  }
  if (!fits(got)) throw new Error(`typed into "${b.label || ref}" but the field shows "${String(got).slice(0, 80)}"`);
  const out = { filled: ref, field: b.label, value: text.slice(0, 80), how, checked: 'the field shows the text' };
  if (!submit) return out;
  const before = (await here(s)).url;
  await pressKey(s, 'Enter');
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) { await sleep(200); after = (await here(s).catch(() => ({ url: before }))).url; }
  if (after === before) {
    await evaluate(`(() => { const el = window.__zk.byRef(${JSON.stringify(ref)}); const f = el && el.form; if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return true; } return false; })()`, s).catch(() => false);
    for (let i = 0; i < 20 && after === before; i++) { await sleep(200); after = (await here(s).catch(() => ({ url: before }))).url; }
  }
  await settle(s, 6000);
  return { ...out, submitted: true, url: after };
}
export async function fill(ref, value) { return typeInto(ref, value); }
export async function press(key, ref) {
  const s = await page();
  if (ref) await clickAt(s, ref);
  const name = await pressKey(s, key);
  await sleep(300); await settle(s, 4000);
  return { pressed: name, url: (await here(s)).url };
}

export async function searchFields() { return call(await page(), 'searchFields'); }
export async function revealSearch() {
  const s = await page();
  const ref = await call(s, 'searchToggle');
  if (!ref) return false;
  await clickAt(s, ref).catch(() => null);
  await sleep(500);
  return true;
}
export async function openSearchTemplate() {
  const s = await page();
  return evaluate(`(document.querySelector('link[rel="search"][type="application/opensearchdescription+xml"]') || {}).href || null`, s);
}
export async function pageState() {
  const s = await page();
  return evaluate(`({ url: location.href, title: document.title, h1: ((window.__zk.all('h1').find(window.__zk.visible) || {}).innerText || '').slice(0, 200) })`, s);
}
export async function waitForUrlChange(from, ms = 9000) {
  const s = await page();
  const until = Date.now() + ms; let url = from;
  while (Date.now() < until) { url = (await here(s).catch(() => ({ url: from }))).url; if (url !== from) break; await sleep(200); }
  await settle(s, 6000);
  return url;
}
export async function results(query) { return call(await page(), 'results', query || ''); }
export async function humanCheck() { return call(await page(), 'humanCheck').catch(() => null); }
export async function media() { return call(await page(), 'mediaState'); }
export async function playMedia() { return call(await page(), 'playMedia'); }

export async function scrollBy(delta = 800) { const s = await page(); const y = await evaluate(`(window.scrollBy(0, ${Number(delta) || 800}), Math.round(window.scrollY))`, s); return { scrolledTo: y }; }
export async function waitFor(textToFind, timeoutMs = 15000) {
  const s = await page(); const until = Date.now() + timeoutMs; const want = JSON.stringify(String(textToFind));
  while (Date.now() < until) { if (await evaluate(`(document.body ? document.body.innerText : '').toLowerCase().includes(${want}.toLowerCase())`, s).catch(() => false)) return { found: textToFind }; await sleep(300); }
  throw new Error(`"${textToFind}" did not appear within ${Math.round(timeoutMs / 1000)} s`);
}
export async function waitForIdle(quietMillis = 700, timeoutMs = 15000) {
  const s = await page(); const until = Date.now() + (timeoutMs || 15000);
  while (Date.now() < until) { if (s.inflight === 0 && Date.now() - s.lastNetwork >= quietMillis) return { idle: true }; await sleep(100); }
  return { idle: false, inflight: s.inflight };
}
export async function clickAndWait(ref, { text: waitText, urlChanges } = {}) {
  const s = await page(); const before = (await here(s)).url;
  const result = await click(ref);
  if (waitText) await waitFor(waitText).catch(() => {});
  if (urlChanges) { const until = Date.now() + 15000; while (Date.now() < until && (await here(current || s)).url === before) await sleep(200); await settle(current || s); }
  await waitForIdle(500, 8000);
  const now = await here(current || s);
  return { ...result, url: now.url, title: now.title };
}
export async function fillForm(fields) { const done = []; for (const f of fields) done.push(await typeInto(f.ref, f.value)); return { filled: done.length }; }
export async function evaluateExpression(expression) {
  const value = await evaluate(`(async () => { const __v = await (${expression}); try { return JSON.parse(JSON.stringify(__v)); } catch { return String(__v); } })()`);
  const textValue = typeof value === 'string' ? value : JSON.stringify(value);
  return { value: textValue?.slice(0, 20000), truncated: (textValue?.length || 0) > 20000 };
}
export async function extract(rowSelector, fields = {}) {
  return evaluate(`(() => { const rows = window.__zk.all(${JSON.stringify(rowSelector)}).slice(0, 200); const fields = ${JSON.stringify(fields)}; return rows.map(row => { const out = {}; for (const [name, sel] of Object.entries(fields)) { const el = sel ? row.querySelector(sel) : row; out[name] = el ? (el.href || el.getAttribute('src') || el.innerText || el.textContent || '').trim().slice(0, 300) : null; } return out; }); })()`);
}
export async function consoleLog({ level = 'all', limit = 50 } = {}) { const s = await page(); return s.console.filter(c => level === 'all' || c.level === 'error').slice(-limit); }
export async function networkLog({ failedOnly = false, urlPattern, limit = 50 } = {}) { const s = await page(); return [...s.network.values()].filter(r => (!failedOnly || r.failed || r.status >= 400) && (!urlPattern || r.url.includes(urlPattern))).slice(-limit); }
export async function resize(width = 1280, height = 800, mobile = false) { const s = await page(); await s.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: mobile ? 2 : 1, mobile: Boolean(mobile) }); return { width, height, mobile }; }
export async function screenshot(file) {
  const s = await page(); const r = await s.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(r.data, 'base64'));
  return { saved: file };
}
export async function savePdf(file) {
  const s = await page();
  mkdirSync(dirname(file), { recursive: true });
  try { const r = await s.send('Page.printToPDF', { printBackground: true }); writeFileSync(file, Buffer.from(r.data, 'base64')); return { saved: file }; }
  catch {
    const url = (await here(s)).url;
    const r = await exec(browserPath(), ['--headless=new', '--disable-gpu', `--print-to-pdf=${file}`, '--no-pdf-header-footer', url], { timeout: 60000 });
    if (!existsSync(file)) throw new Error('could not print this page to PDF: ' + (r.err || '').slice(0, 200));
    return { saved: file, note: 'printed without your session (headless copy of the page)' };
  }
}
export async function upload(ref, path) {
  const s = await page();
  const { result } = await s.send('Runtime.evaluate', { expression: `${HELPER}window.__zk.byRef(${JSON.stringify(String(ref))})` });
  if (!result?.objectId) throw new Error(`no upload control ${ref}`);
  await s.send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId });
  return { attached: path, to: ref };
}
export async function extensions() { await launch(); return ((await api('/json/list')) || []).filter(t => t.url.startsWith('chrome-extension://') && t.type !== 'service_worker').map(t => ({ viewId: t.id, title: t.title, url: t.url })); }
export async function focusExtension(viewId) { const t = ((await api('/json/list')) || []).find(x => x.id === viewId); if (!t) throw new Error(`no extension view ${viewId}`); current = await connect(t); return { focused: t.title }; }

export async function waitForDownload(folder, timeoutSeconds = 120, nameContains = '') {
  const dir = folder || join(os.homedir(), 'Downloads');
  const before = new Map(readdirSync(dir).map(f => [f, statSync(join(dir, f)).mtimeMs]));
  const started = Date.now();
  while (Date.now() - started < timeoutSeconds * 1000) {
    for (const f of readdirSync(dir)) {
      if (/\.(crdownload|part|tmp|download)$/i.test(f)) continue;
      if (nameContains && !f.toLowerCase().includes(nameContains.toLowerCase())) continue;
      const m = statSync(join(dir, f)).mtimeMs;
      if (!before.has(f) || before.get(f) < m) { await sleep(500); return { path: join(dir, f), size: statSync(join(dir, f)).size }; }
    }
    await sleep(500);
  }
  throw new Error(`no download arrived in ${dir} within ${timeoutSeconds} s`);
}
export function available() { return Boolean(browserPath()); }
