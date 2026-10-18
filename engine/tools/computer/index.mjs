import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join, dirname, basename, extname, relative, resolve as resolvePathAbs } from 'node:path';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as P from '../../os/platform.mjs';
import * as desktop from '../../os/native.mjs';
import * as B from '../../os/browser.mjs';
import { writeSimpleDocx, writeSimpleXlsx, plainTextFromDocx, plainTextFromXlsx, plainTextFromPptx } from '../../os/simpleDocuments.mjs';
import { search } from '../../search.mjs';
import { read as readPage } from '../../reader.mjs';
import * as mouth from '../../mouth.mjs';
import { DATA } from '../../util.mjs';

const require = createRequire(import.meta.url);
const SCHEMAS = require('./schemas.json')[P.PLATFORM] || require('./schemas.json').linux;

const IRREVERSIBLE = /\b(submit|send|post|publish|buy|purchase|pay|checkout|check out|place order|order now|confirm|delete|remove|unsubscribe|subscribe|sign up|register|transfer|book now|reserve|donate|tweet|reply|share now|accept|agree)\b/i;
async function inSafeZone(path) {
  const f = await P.folders();
  const full = resolvePathAbs(path).toLowerCase();
  return [f.workspace, f.downloads, join(DATA, 'media')].some(root => full.startsWith(resolvePathAbs(root).toLowerCase()));
}
const writeRisk = key => async args => (await inSafeZone(await P.resolvePath(args[key]))) ? 'harmless' : 'change';
const mb = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const SKIP = /^(node_modules|\.git|\.venv|venv|__pycache__|AppData|\$Recycle\.Bin|Library|\.cache)$/;
function walk(root, visit, { budgetMs = 4000, maxFiles = 80000 } = {}) {
  const until = Date.now() + budgetMs; let seen = 0; const stack = [root];
  while (stack.length && Date.now() < until && seen < maxFiles) {
    const dir = stack.pop(); let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++; const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.test(e.name) && !e.name.startsWith('.')) stack.push(full); }
      else if (e.isFile()) { if (visit(full) === false) return { seen, stopped: true }; }
    }
  }
  return { seen, complete: !stack.length };
}
function globToRegex(pattern) {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') { re += '.*'; i++; if (p[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`(^|/)${re}$`, 'i');
}
function imageSize(buffer) {
  if (buffer.slice(1, 4).toString() === 'PNG') return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.slice(0, 3).toString() === 'GIF') return { type: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') {
    const chunk = buffer.slice(12, 16).toString();
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { type: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const b = buffer.readUInt32LE(21); return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i < buffer.length) {
      if (buffer[i] !== 0xff) { i++; continue; }
      const marker = buffer[i + 1], len = buffer.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

const NEVER = [
  /\b(format-volume|format\s+[a-z]:|diskpart|bcdedit|vssadmin\s+delete|wbadmin\s+delete|cipher\s+\/w|clear-recyclebin|set-executionpolicy|set-mppreference|add-mppreference|disable-computerrestore|reg(\.exe)?\s+delete\s+hk(lm|ey_local_machine)|remove-item\s+.*(hklm:|[a-z]:\\windows|system32))/i,
  /\b(mkfs(\.\w+)?|fdisk|parted|wipefs|shred|dd\s+.*of=\/dev\/|chmod\s+-r\s+777\s+\/|chown\s+-r\s+.*\s+\/(\s|$)|csrutil|nvram|launchctl\s+unload\s+.*system)/i,
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~\/?|\$home|\/\*|\.\/?\*?)(\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sh|bash|zsh|iex|invoke-expression|python)/i
];
const READ_ONLY = /^(get-|test-|measure-|select-|sort-|where-|format-|group-|compare-|out-string|convertto-|convertfrom-|resolve-path|split-path|join-path|\$psversiontable|ipconfig|systeminfo|whoami|hostname|ls|dir|gci|cat|type|head|tail|wc|grep|rg|find(?!.*-(delete|exec))|du|df|ps|top\s+-l|uptime|uname|sw_vers|lsb_release|which|where|echo|printf|date|pwd|env|printenv|stat|file|tree|nslookup|dig|ping|traceroute|tracert|netstat|ss|lsof|free|vm_stat|system_profiler|sysctl|defaults\s+read|(python3?|node|npm|git|java|go|rustc|cargo|dotnet|pip3?)\s+(--version|-v|version)|git\s+(status|log|diff|branch|show|remote)|winget\s+(list|search|show)|brew\s+(list|info|search)|apt\s+(list|show|search)|dpkg\s+-l|rpm\s+-q)/i;
const WRITES = /(^|[\s;|&(])(set-|new-|remove-|rename-|move-|copy-|clear-|stop-|start-|restart-|invoke-|install-|uninstall-|update-|add-|enable-|disable-|register-|out-file|set-content|add-content|export-|rm|rmdir|del|erase|mv|cp|mkdir|md|ren|touch|chmod|chown|kill|pkill|killall|taskkill|shutdown|reboot|halt|poweroff|systemctl|launchctl|sudo|su|apt|apt-get|dnf|yum|pacman|brew\s+(install|uninstall|upgrade)|npm\s+(i|install|uninstall|update)|pip3?\s+(install|uninstall)|winget\s+(install|uninstall|upgrade)|git\s+(push|commit|reset|checkout|clean|rebase|merge)|tee|sed\s+-i|truncate|ln)\b|>{1,2}/i;
export function classifyCommand(command) {
  const c = String(command).trim();
  if (NEVER.some(re => re.test(c))) return 'never';
  const parts = c.split(/\s*(?:\|\||&&|[|;])\s*/).filter(Boolean);
  const harmlessPipe = /^(foreach-object|%|select(-object)?|sort(-object)?|where(-object)?|\?|measure(-object)?|format-\w+|ft|fl|out-string|head|tail|grep|sort|uniq|wc|awk|cut|tr|less|more)\b/i;
  if (!WRITES.test(c) && parts.every(p => READ_ONLY.test(p) || harmlessPipe.test(p) || /^\(.*\)(\.\w+)*$/.test(p))) return 'read';
  return 'change';
}

async function askAboutImage(file, question) {
  const image = fs.readFileSync(file).toString('base64');
  const answer = await mouth.json([
    { role: 'system', content: 'You look at a screenshot and answer one yes/no question about it, with the short visible evidence. Output JSON.' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }, { type: 'text', text: question }] }
  ], { type: 'object', properties: { answer: { enum: ['yes', 'no'] }, evidence: { type: 'string' } }, required: ['answer', 'evidence'] }, { maxTokens: 120 });
  if (!answer) throw new Error('the language model could not look at the screen (start it with vision: the mmproj file in runtime/)');
  return answer;
}

const T = {};
const def = (name, risk, run, describe) => { T[name] = { risk, run, describe }; };

def('list_files', 'read', async ({ path }) => {
  const dir = await P.resolvePath(path);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const rows = [];
  for (const e of entries.slice(0, 500)) {
    let size = null, modified = null;
    try { const s = await fsp.stat(join(dir, e.name)); size = e.isFile() ? s.size : null; modified = s.mtime.toISOString().slice(0, 16).replace('T', ' '); } catch {}
    rows.push({ name: e.name + (e.isDirectory() ? '/' : ''), size: size != null ? mb(size) : '', modified });
  }
  return { path: dir, count: entries.length, entries: rows };
});
def('read_file', 'read', async ({ path, offset = 0, length = 60000 }) => {
  const file = await P.resolvePath(path);
  const ext = extname(file).toLowerCase();
  const len = Math.min(250000, Number(length) || 60000), off = Number(offset) || 0;
  let text;
  if (ext === '.docx') text = plainTextFromDocx(file);
  else if (ext === '.xlsx') text = plainTextFromXlsx(file);
  else if (ext === '.pptx') text = plainTextFromPptx(file);
  else {
    const fd = await fsp.open(file, 'r');
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fd.read(buf, 0, len, off);
    await fd.close();
    if (buf.slice(0, Math.min(bytesRead, 8000)).includes(0)) throw new Error(`${basename(file)} is a binary file, not text`);
    return { path: file, offset: off, text: buf.slice(0, bytesRead).toString('utf8'), more: bytesRead === len };
  }
  return { path: file, offset: off, text: text.slice(off, off + len), more: text.length > off + len };
});
def('write_file', writeRisk('path'), async ({ path, content = '' }) => {
  const file = await P.resolvePath(path);
  await fsp.mkdir(dirname(file), { recursive: true });
  await fsp.writeFile(file, String(content), 'utf8');
  return { written: file, bytes: Buffer.byteLength(String(content)) };
}, a => `Write ${a.path}`);
def('edit_file', writeRisk('path'), async ({ path, old_string, new_string, replace_all }) => {
  const file = await P.resolvePath(path);
  const text = await fsp.readFile(file, 'utf8');
  const count = text.split(old_string).length - 1;
  if (!count) throw new Error('the exact snippet was not found; read the file and copy it exactly');
  if (count > 1 && !replace_all) throw new Error(`the snippet appears ${count} times; include more context or set replace_all`);
  await fsp.writeFile(file, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string), 'utf8');
  return { edited: file, replacements: replace_all ? count : 1 };
}, a => `Edit ${a.path}`);
def('copy_file', writeRisk('destination'), async ({ source, destination }) => {
  const from = await P.resolvePath(source), to = await P.resolvePath(destination);
  await fsp.mkdir(dirname(to), { recursive: true });
  await fsp.cp(from, to, { recursive: true, errorOnExist: false });
  return { copied: from, to };
}, a => `Copy ${a.source} → ${a.destination}`);
def('move_file', 'change', async ({ source, destination }) => {
  const from = await P.resolvePath(source); let to = await P.resolvePath(destination);
  if (fs.existsSync(to) && fs.statSync(to).isDirectory()) to = join(to, basename(from));
  await fsp.mkdir(dirname(to), { recursive: true });
  await fsp.rename(from, to).catch(async () => { await fsp.cp(from, to, { recursive: true }); await P.toTrash(from); });
  return { moved: from, to };
}, a => `Move ${a.source} → ${a.destination}`);
def('delete_file', 'change', async ({ path }) => {
  const file = await P.resolvePath(path);
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  const r = await P.toTrash(file);
  if (fs.existsSync(file)) throw new Error(`could not move it to the ${P.TRASH_NAME}: ${(r.err || '').slice(0, 200)}`);
  return { movedToTrash: file, note: `Recoverable from the ${P.TRASH_NAME}.` };
}, a => `Move ${a.path} to the ${P.TRASH_NAME}`);
def('make_directory', writeRisk('path'), async ({ path }) => { const dir = await P.resolvePath(path); await fsp.mkdir(dir, { recursive: true }); return { created: dir }; }, a => `Create the folder ${a.path}`);
def('glob_search', 'read', async ({ pattern, path }) => {
  const root = await P.resolvePath(path || '~'); const re = globToRegex(pattern); const hits = [];
  const r = walk(root, file => { if (re.test(relative(root, file).replace(/\\/g, '/'))) hits.push(file); return hits.length < 500; });
  return { root, pattern, count: hits.length, files: hits.slice(0, 200), complete: Boolean(r.complete) };
});
def('grep_search', 'read', async ({ pattern, path }) => {
  const root = await P.resolvePath(path || '~'); const re = new RegExp(pattern, 'i'); const matches = [];
  walk(root, file => {
    if (/\.(png|jpe?g|gif|webp|ico|zip|7z|rar|exe|dll|so|dylib|pdf|mp[34]|mov|mkv|wav|iso|bin|gguf|onnx)$/i.test(file)) return true;
    try { if (fs.statSync(file).size > 2_000_000) return true; fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (matches.length < 300 && re.test(line)) matches.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`); }); } catch {}
    return matches.length < 300;
  }, { budgetMs: 6000 });
  return { root, pattern, count: matches.length, matches };
});
def('create_archive', writeRisk('archive'), async ({ source, archive }) => {
  const from = await P.resolvePath(source), to = await P.resolvePath(archive.endsWith('.zip') ? archive : archive + '.zip');
  const zip = new AdmZip();
  if (fs.statSync(from).isDirectory()) zip.addLocalFolder(from, basename(from)); else zip.addLocalFile(from);
  await fsp.mkdir(dirname(to), { recursive: true });
  zip.writeZip(to);
  return { archive: to, size: mb(fs.statSync(to).size) };
}, a => `Create ${a.archive}`);
def('extract_archive', writeRisk('destination'), async ({ archive, destination }) => {
  const from = await P.resolvePath(archive), to = await P.resolvePath(destination);
  const zip = new AdmZip(from);
  for (const e of zip.getEntries()) if (!resolvePathAbs(to, e.entryName).startsWith(resolvePathAbs(to))) throw new Error('the archive tries to write outside its folder; refused');
  zip.extractAllTo(to, true);
  return { extracted: zip.getEntries().length + ' entries', to };
}, a => `Extract ${a.archive} into ${a.destination}`);
def('write_document', writeRisk('path'), async ({ path, title = '', content = '' }) => {
  const file = await P.resolvePath(/\.(docx|pdf|xlsx)$/i.test(path) ? path : String(path).replace(/\.(doc|txt|md|rtf)$/i, '') + '.docx');
  await fsp.mkdir(dirname(file), { recursive: true });
  const ext = extname(file).toLowerCase();
  const body = title && !content.startsWith('#') ? `# ${title}\n${content}` : content;
  if (ext === '.docx') writeSimpleDocx(file, body);
  else if (ext === '.xlsx') writeSimpleXlsx(file, content);
  else if (ext === '.pdf') {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let pageObj = pdf.addPage([595, 842]); let y = 790; const margin = 56, width = 595 - 2 * margin;
    const line = (text, f, size, gap) => {
      const words = text.replace(/[^\x20-\x7E -ÿ]/g, '').split(' '); let current = '';
      const flush = () => { if (y < 60) { pageObj = pdf.addPage([595, 842]); y = 790; } pageObj.drawText(current, { x: margin, y, size, font: f, color: rgb(0.1, 0.1, 0.12) }); y -= size + gap; current = ''; };
      for (const w of words) { if (f.widthOfTextAtSize(current + ' ' + w, size) > width && current) flush(); current = current ? current + ' ' + w : w; }
      flush();
    };
    for (const raw of body.split('\n')) {
      if (!raw.trim()) { y -= 8; continue; }
      if (raw.startsWith('# ')) line(raw.slice(2), bold, 18, 10); else if (raw.startsWith('## ')) line(raw.slice(3), bold, 14, 8); else if (/^[-*] /.test(raw)) line('•  ' + raw.slice(2), font, 11, 5); else line(raw, font, 11, 5);
    }
    await fsp.writeFile(file, await pdf.save());
  } else throw new Error('write_document makes .docx, .pdf or .xlsx files; use write_file for plain text');
  return { written: file, size: mb(fs.statSync(file).size) };
}, a => `Create the document ${a.path}`);

def('open_folder', 'harmless', async ({ path }) => { const dir = await P.resolvePath(path); await P.openTarget(dir); return { opened: dir }; });
def('open_terminal', 'harmless', async ({ path }) => { const dir = await P.resolvePath(path); await P.openTerminal(dir); return { opened: `${P.SHELL_NAME} in ${dir}` }; });
def('open_with', 'harmless', async ({ path, program }) => { const file = await P.resolvePath(path); await P.openWith(file, program); return { opened: file, with: program }; });
const showPage = async url => { if (!B.available()) { await P.openTarget(url); return { opened: url, in: 'your default browser (no Chromium-based browser is installed for the agent)' }; } return B.open(url); };
def('open_url', 'harmless', async ({ url }) => { if (!/^https?:\/\//i.test(url)) throw new Error('needs a full http(s) URL'); return showPage(url); });
def('open_search_in_browser', 'harmless', async ({ query }) => showPage(`https://www.google.com/search?q=${encodeURIComponent(query)}`));
def('open_app', 'harmless', async ({ name, arguments: args = [] }) => P.launchApp(name, Array.isArray(args) ? args.map(String) : String(args || '').split(' ').filter(Boolean)));

def('web_search', 'read', async ({ query }) => {
  const r = await search(query);
  return { query, results: r.results.slice(0, 8).map(x => ({ title: x.title, url: x.url, snippet: x.snippet.slice(0, 300) })) };
});
def('fetch_url', 'read', async ({ url }) => {
  const page = await readPage(url, { fresh: true });
  return { url, title: page.title, text: page.passages.map(p => (p.section && p.section !== 'Overview' ? `[${p.section}] ` : '') + p.text).join('\n').slice(0, 12000) };
});
def('http_request', args => (!args.method || /^get$/i.test(args.method)) ? 'read' : 'change', async ({ url, method = 'GET', headers = {}, body }) => {
  const response = await fetch(url, { method, headers, body: body && !/^(GET|HEAD)$/i.test(method) ? body : undefined, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type'), body: text.slice(0, 20000), truncated: text.length > 20000 };
}, a => `${a.method || 'GET'} ${a.url}`);
def('download_file', writeRisk('path'), async ({ url, path }) => {
  const file = await P.resolvePath(path);
  await fsp.mkdir(dirname(file), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { pipeline } = await import('node:stream/promises'); const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
  return { saved: file, size: mb(fs.statSync(file).size), type: response.headers.get('content-type') };
}, a => `Download ${a.url} to ${a.path}`);
def('verify_image', 'read', async ({ path, minimumWidth = 200, minimumHeight = 200 }) => {
  const file = await P.resolvePath(path); const buf = fs.readFileSync(file); const size = imageSize(buf);
  if (!size) return { ok: false, reason: 'not a PNG, JPEG, GIF or WebP image' };
  const ok = size.width >= minimumWidth && size.height >= minimumHeight && buf.length > 3000;
  return { ok, ...size, bytes: buf.length, reason: ok ? 'a real image of usable size' : 'too small to be a real picture' };
});
def('wait_for_download', 'read', async ({ folder, timeoutSeconds = 300, nameContains = '' }) => B.waitForDownload(folder ? await P.resolvePath(folder) : (await P.folders()).downloads, timeoutSeconds, nameContains));

def('clipboard_read', 'read', async () => ({ text: (await P.clipboardRead()).slice(0, 20000) }));
def('clipboard_write', 'harmless', async ({ text }) => { await P.clipboardWrite(String(text)); return { copied: String(text).length + ' characters' }; });
def('get_datetime', 'read', async ({ timeZone }) => {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone; const now = new Date();
  return { iso: now.toISOString(), local: now.toLocaleString('en-US', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }), timeZone: zone };
});
def('run_command', args => classifyCommand(args.command), async ({ command, cwd }) => {
  const dir = cwd ? await P.resolvePath(cwd) : (await P.folders()).home;
  const r = await P.shell(command, { cwd: fs.existsSync(dir) ? dir : undefined, timeout: 120000 });
  return { exitCode: r.code, output: (r.out || '').slice(0, 12000), errors: (r.err || '').slice(0, 3000) };
}, a => a.command);

def('list_windows', 'read', async () => ({ windows: (await desktop.listWindows()).map(w => w.title) }));
def('focus_window', 'harmless', async ({ title }) => desktop.focusWindow(title));
def('read_screen', 'read', async () => desktop.readForeground());
def('click_element', args => IRREVERSIBLE.test(args.name || '') ? 'change' : 'harmless', async ({ name }) => desktop.clickByName(name), a => `Click "${a.name}"`);
def('type_text', 'harmless', async ({ text, into }) => desktop.typeByName(String(text), into));
def('press_key', 'harmless', async ({ key }) => desktop.pressKey(String(key)));
def('scroll_page', 'harmless', async ({ direction = 'down', amount = 3 }) => desktop.scroll((/up/i.test(direction) ? -1 : 1) * Math.max(1, Math.min(20, Number(amount) || 3))));
def('take_screenshot', 'harmless', async ({ path }) => {
  const file = path ? await P.resolvePath(path.endsWith('.png') ? path : path + '.png') : join(DATA, 'media', `screen-${Date.now()}.png`);
  const r = await P.screenshot(file);
  if (!fs.existsSync(file)) throw new Error('screenshot failed: ' + (r.err || '').slice(0, 200));
  return { saved: file, media: file.startsWith(join(DATA, 'media')) ? basename(file) : null };
});
def('check_screen', 'read', async ({ question }) => {
  const file = join(DATA, 'media', `check-${Date.now()}.png`);
  await P.screenshot(file);
  return askAboutImage(file, question);
});

def('open_page', 'harmless', async ({ url }) => B.open(url));
def('browser_read', 'read', async () => B.read());
def('browser_text', 'read', async ({ maxCharacters }) => B.text(maxCharacters));
def('browser_find', 'read', async ({ query }) => B.find(query));
def('browser_screenshot', 'harmless', async ({ path }) => { const file = path ? await P.resolvePath(path.replace(/\.[^.\\/]*$/, '') + '.png') : join(DATA, 'media', `page-${Date.now()}.png`); return { ...(await B.screenshot(file)), media: file.startsWith(join(DATA, 'media')) ? basename(file) : null }; });
const labelRisk = async ref => { try { const f = await B.find(''); const el = f.matches.find(e => e.ref === ref); return el && IRREVERSIBLE.test(`${el.name} ${el.role}`) ? 'change' : 'harmless'; } catch { return 'harmless'; } };
def('browser_click', args => labelRisk(args.ref), async ({ ref }) => B.click(ref), a => `Click element ${a.ref} on the page`);
def('browser_click_and_wait', args => labelRisk(args.ref), async ({ ref, waitForText, waitForNewPage }) => B.clickAndWait(ref, { text: waitForText, urlChanges: waitForNewPage }), a => `Click element ${a.ref} on the page`);
def('browser_click_special', args => labelRisk(args.ref), async ({ ref, button, clickCount }) => B.click(ref, { button: button === 'right' ? 'right' : 'left', clickCount: Number(clickCount) || 1 }), a => `Click element ${a.ref}`);
def('browser_fill', 'harmless', async ({ ref, value }) => B.fill(ref, value));
def('browser_fill_form', args => args.submitRef ? labelRisk(args.submitRef) : 'harmless', async ({ fields = [], submitRef }) => { const filled = await B.fillForm(fields); return submitRef ? { ...filled, submitted: await B.clickAndWait(submitRef, {}) } : filled; }, a => `Fill ${a.fields?.length || 0} fields${a.submitRef ? ' and submit the form' : ''}`);
def('browser_press', 'harmless', async ({ key, ref }) => B.press(key, ref));
def('browser_scroll', 'harmless', async ({ delta }) => B.scrollBy(delta));
def('browser_back', 'harmless', async () => B.back());
def('browser_wait_for', 'read', async ({ text }) => B.waitFor(text));
def('browser_wait_for_idle', 'read', async ({ quietMillis, timeoutSeconds }) => B.waitForIdle(Number(quietMillis) || 700, (Number(timeoutSeconds) || 15) * 1000));
def('browser_tabs', 'read', async () => ({ tabs: await B.tabs() }));
def('browser_open_tab', 'harmless', async ({ url }) => B.openTab(url));
def('browser_switch_tab', 'harmless', async ({ tabId }) => B.switchTab(tabId));
def('browser_close_tab', 'harmless', async ({ tabId }) => B.closeTab(tabId));
def('browser_extract', 'read', async ({ rowSelector, fields }) => {
  const rows = await B.extract(rowSelector, Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, String(v).split('@')[0]])));
  return { count: rows.length, rows };
});
def('browser_evaluate', 'change', async ({ expression }) => B.evaluateExpression(expression), a => `Run JavaScript on the page: ${String(a.expression).slice(0, 120)}`);
def('browser_console', 'read', async ({ level, limit }) => ({ messages: await B.consoleLog({ level, limit }) }));
def('browser_network', 'read', async ({ failedOnly, urlPattern, limit }) => ({ requests: await B.networkLog({ failedOnly, urlPattern, limit }) }));
def('browser_hover', 'harmless', async ({ ref }) => B.hover(ref));
def('browser_drag', 'harmless', async ({ fromRef, toRef }) => B.drag(fromRef, toRef));
def('browser_resize', 'harmless', async ({ width, height, mobile }) => B.resize(width, height, mobile));
def('browser_save_pdf', writeRisk('path'), async ({ path }) => B.savePdf(await P.resolvePath(path)), a => `Save the page as ${a.path}`);
def('upload_file', 'change', async ({ ref, path }) => B.upload(ref, await P.resolvePath(path)), a => `Attach ${a.path} to the page`);
def('browser_extensions', 'read', async () => ({ extensions: await B.extensions() }));
def('browser_focus_extension', 'harmless', async ({ viewId }) => B.focusExtension(viewId));

const FAMILY = name => /^browser_|^open_page$|^upload_file$/.test(name) ? 'Browser' : /screen|window|click_element|type_text|press_key|scroll_page|open_app/.test(name) ? 'Desktop' : /web_search|fetch_url|http_request|download|open_url|open_search|verify_image/.test(name) ? 'Web' : /run_command|open_terminal|clipboard|get_datetime/.test(name) ? 'System' : 'Files';

export const computerTools = SCHEMAS.filter(s => T[s.name]).map(schema => ({
  id: schema.name,
  title: schema.name.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()),
  family: FAMILY(schema.name),
  description: schema.description,
  parameters: schema.parameters,
  risk: T[schema.name].risk,
  describe: T[schema.name].describe || (a => `${schema.name} ${JSON.stringify(a).slice(0, 160)}`),
  agentOnly: true,
  run: T[schema.name].run
}));
export const missing = SCHEMAS.filter(s => !T[s.name]).map(s => s.name);
