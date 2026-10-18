import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import os from 'node:os';

export const PLATFORM = process.platform;
export const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[PLATFORM] || PLATFORM;
export const SHELL_NAME = PLATFORM === 'win32' ? 'PowerShell' : 'shell';

export function exec(command, args = [], { timeout = 30000, cwd, input, env } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true }); }
    catch (error) { return resolve({ code: -1, out: '', err: error.message }); }
    let out = '', err = '', done = false;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ code: -1, out: out.trim(), err: (err + '\n(timed out)').trim() }); }, timeout);
    child.stdout?.on('data', d => { out += d; if (out.length > 400_000) child.kill(); });
    child.stderr?.on('data', d => { err += d; });
    child.on('error', e => finish({ code: -1, out: '', err: e.message }));
    child.on('close', code => finish({ code, out: out.trim(), err: err.trim() }));
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
  });
}

export function shell(command, { timeout = 60000, cwd } = {}) {
  if (PLATFORM === 'win32') {
    const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
    return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout, cwd });
  }
  const sh = existsSync('/bin/zsh') && PLATFORM === 'darwin' ? '/bin/zsh' : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return exec(sh, ['-lc', command], { timeout, cwd });
}
export const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
export const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const quote = PLATFORM === 'win32' ? psQuote : shQuote;
const which = async name => (await exec(PLATFORM === 'win32' ? 'where' : 'which', [name], { timeout: 4000 })).code === 0;

let known = null;
export async function folders() {
  if (known) return known;
  const home = os.homedir();
  const base = { home, desktop: join(home, 'Desktop'), documents: join(home, 'Documents'), downloads: join(home, 'Downloads'), pictures: join(home, 'Pictures'), music: join(home, 'Music'), videos: join(home, PLATFORM === 'darwin' ? 'Movies' : 'Videos') };
  if (PLATFORM === 'win32') {
    const r = await shell(`[pscustomobject]@{ desktop=[Environment]::GetFolderPath('Desktop'); documents=[Environment]::GetFolderPath('MyDocuments'); pictures=[Environment]::GetFolderPath('MyPictures'); music=[Environment]::GetFolderPath('MyMusic'); videos=[Environment]::GetFolderPath('MyVideos'); downloads=(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } | ConvertTo-Json -Compress`);
    try { Object.assign(base, Object.fromEntries(Object.entries(JSON.parse(r.out)).filter(([, v]) => v))); } catch {}
  } else if (PLATFORM === 'linux') {
    try {
      const dirs = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
      const get = key => dirs.match(new RegExp(`^XDG_${key}_DIR="(.+)"`, 'm'))?.[1]?.replace('$HOME', home);
      Object.assign(base, Object.fromEntries([['desktop', get('DESKTOP')], ['documents', get('DOCUMENTS')], ['downloads', get('DOWNLOAD')], ['pictures', get('PICTURES')], ['music', get('MUSIC')], ['videos', get('VIDEOS')]].filter(([, v]) => v)));
    } catch {}
  }
  base.workspace = join(base.documents, 'OpenSpawn Bot');
  known = base;
  return known;
}

export async function resolvePath(input) {
  const f = await folders();
  let p = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!p) return f.workspace;
  if (p.startsWith('~')) p = join(f.home, p.slice(1));
  if (/^[a-z]:[\\/]/i.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p;
  const first = p.split(/[\\/]/)[0].toLowerCase();
  const alias = { desktop: 'desktop', documents: 'documents', document: 'documents', downloads: 'downloads', download: 'downloads', pictures: 'pictures', photos: 'pictures', music: 'music', videos: 'videos', movies: 'videos', home: 'home', workspace: 'workspace' }[first];
  if (alias) return join(f[alias], p.split(/[\\/]/).slice(1).join('/'));
  return join(f.workspace, p);
}

export async function openTarget(target) {
  if (PLATFORM === 'win32') return shell(`Start-Process ${psQuote(target)}`);
  if (PLATFORM === 'darwin') return exec('open', [target]);
  return exec('xdg-open', [target]);
}
export async function openWith(path, program) {
  if (PLATFORM === 'win32') return shell(`Start-Process -FilePath ${psQuote(program)} -ArgumentList ${psQuote('"' + path + '"')}`);
  if (PLATFORM === 'darwin') return exec('open', ['-a', program, path]);
  return exec(program, [path]);
}
export async function openTerminal(cwd) {
  if (PLATFORM === 'win32') return shell(`Start-Process powershell.exe -WorkingDirectory ${psQuote(cwd)}`);
  if (PLATFORM === 'darwin') return exec('open', ['-a', 'Terminal', cwd]);
  for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']) {
    if (await which(term)) return exec(term, term === 'gnome-terminal' ? [`--working-directory=${cwd}`] : [], { cwd });
  }
  return { code: 1, out: '', err: 'no terminal emulator found' };
}

let appCache = null;
export async function applications() {
  if (appCache) return appCache;
  if (PLATFORM === 'win32') {
    const r = await shell('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress');
    try { appCache = JSON.parse(r.out).filter(a => a.Name && a.AppID).map(a => ({ name: a.Name, id: a.AppID })); } catch { appCache = []; }
  } else if (PLATFORM === 'darwin') {
    appCache = [];
    for (const dir of ['/Applications', '/System/Applications', '/System/Applications/Utilities', join(os.homedir(), 'Applications')]) {
      try { for (const e of readdirSync(dir)) if (e.endsWith('.app')) appCache.push({ name: e.replace(/\.app$/, ''), id: join(dir, e) }); } catch {}
    }
  } else {
    appCache = [];
    for (const dir of ['/usr/share/applications', '/usr/local/share/applications', join(os.homedir(), '.local/share/applications'), '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications']) {
      try {
        for (const e of readdirSync(dir)) if (e.endsWith('.desktop')) {
          const text = readFileSync(join(dir, e), 'utf8');
          const name = text.match(/^Name=(.+)$/m)?.[1];
          if (name && !/^NoDisplay=true$/m.test(text)) appCache.push({ name, id: e.replace(/\.desktop$/, '') });
        }
      } catch {}
    }
  }
  return appCache;
}
const ALIASES = { chrome: 'google chrome', edge: 'microsoft edge', vscode: 'visual studio code', 'vs code': 'visual studio code', code: 'visual studio code', explorer: 'file explorer', files: 'file explorer', finder: 'finder', cmd: 'command prompt', calc: 'calculator', word: 'word', excel: 'excel' };
export async function findApp(name) {
  const want = (ALIASES[name.toLowerCase().trim()] || name).toLowerCase().trim();
  const list = await applications();
  const score = a => { const n = a.name.toLowerCase(); return n === want ? 100 : n.startsWith(want) ? 80 : n.split(/\s+/).includes(want) ? 70 : n.includes(want) ? 50 : want.split(' ').every(w => n.includes(w)) ? 40 : 0; };
  return list.map(a => ({ a, s: score(a) })).filter(x => x.s).sort((x, y) => y.s - x.s || x.a.name.length - y.a.name.length)[0]?.a || null;
}
export async function launchApp(name, args = []) {
  const app = await findApp(name);
  if (PLATFORM === 'win32') {
    if (app) { await shell(`Start-Process ${psQuote('shell:AppsFolder\\' + app.id)}`); return { started: app.name }; }
    const r = await shell(`Start-Process -FilePath ${psQuote(name)}${args.length ? ` -ArgumentList ${args.map(psQuote).join(',')}` : ''}`);
    if (r.code) throw new Error(`no program called "${name}" was found`);
    return { started: name };
  }
  if (PLATFORM === 'darwin') {
    const r = await exec('open', app ? ['-a', app.id, ...(args.length ? ['--args', ...args] : [])] : ['-a', name, ...(args.length ? ['--args', ...args] : [])]);
    if (r.code) throw new Error(`no application called "${name}" was found`);
    return { started: app?.name || name };
  }
  if (app) { const r = await exec('gtk-launch', [app.id]); if (!r.code) return { started: app.name }; }
  const child = spawn(name, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { started: name };
}

export async function clipboardRead() {
  if (PLATFORM === 'win32') return (await shell('Get-Clipboard -Raw')).out;
  if (PLATFORM === 'darwin') return (await exec('pbpaste')).out;
  const r = await exec('wl-paste', ['--no-newline']);
  return r.code === 0 ? r.out : (await exec('xclip', ['-selection', 'clipboard', '-o'])).out;
}
export async function clipboardWrite(text) {
  if (PLATFORM === 'win32') return shell(`Set-Clipboard -Value ${psQuote(text)}`);
  if (PLATFORM === 'darwin') return exec('pbcopy', [], { input: text });
  const r = await exec('wl-copy', [], { input: text });
  return r.code === 0 ? r : exec('xclip', ['-selection', 'clipboard'], { input: text });
}

export async function toTrash(path) {
  if (PLATFORM === 'win32') {
    return shell(`Add-Type -AssemblyName Microsoft.VisualBasic; $p=${psQuote(path)}; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }`);
  }
  if (PLATFORM === 'darwin') return exec('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(path)}`]);
  const r = await exec('gio', ['trash', path]);
  return r.code === 0 ? r : exec('trash-put', [path]);
}
export const TRASH_NAME = PLATFORM === 'win32' ? 'Recycle Bin' : 'Trash';

export async function screenshot(file) {
  mkdirSync(join(file, '..'), { recursive: true });
  if (PLATFORM === 'win32') {
    return shell(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save(${psQuote(file)},[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`);
  }
  if (PLATFORM === 'darwin') return exec('screencapture', ['-x', file]);
  for (const [cmd, args] of [['grim', [file]], ['gnome-screenshot', ['-f', file]], ['spectacle', ['-b', '-n', '-o', file]], ['scrot', [file]], ['import', ['-window', 'root', file]]]) {
    if (await which(cmd)) { const r = await exec(cmd, args); if (r.code === 0 && existsSync(file)) return r; }
  }
  return { code: 1, out: '', err: 'no screenshot tool found (install grim, gnome-screenshot or scrot)' };
}

export async function disks() {
  if (PLATFORM === 'win32') {
    const r = await shell("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ mount=$_.DeviceID; free=$_.FreeSpace; size=$_.Size } } | ConvertTo-Json -Compress");
    try { const d = JSON.parse(r.out); return Array.isArray(d) ? d : [d]; } catch { return []; }
  }
  const r = await exec('df', ['-kP']);
  return r.out.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(c => c.length >= 6 && /^\/($|home|Users|System\/Volumes\/Data|mnt|media)/.test(c[5]) && !c[5].startsWith('/System/Volumes/VM')).map(c => ({ mount: c[5], size: Number(c[1]) * 1024, free: Number(c[3]) * 1024 }));
}
export async function processes() {
  if (PLATFORM === 'win32') {
    const r = await shell('Get-Process | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{ name=$_.Name; mem=($_.Group | Measure-Object WorkingSet64 -Sum).Sum; cpu=[math]::Round(($_.Group | Measure-Object CPU -Sum).Sum,1); count=$_.Count } } | Sort-Object mem -Descending | Select-Object -First 15 | ConvertTo-Json -Compress');
    try { return JSON.parse(r.out); } catch { return []; }
  }
  const r = await exec('ps', ['-axo', 'comm=,rss=,%cpu=']);
  const groups = {};
  for (const line of r.out.split('\n')) {
    const m = line.trim().match(/^(.*?)\s+(\d+)\s+([\d.]+)$/);
    if (!m) continue;
    const name = basename(m[1]);
    const g = groups[name] ||= { name, mem: 0, cpu: 0, count: 0 };
    g.mem += Number(m[2]) * 1024; g.cpu += Number(m[3]); g.count++;
  }
  return Object.values(groups).sort((a, b) => b.mem - a.mem).slice(0, 15);
}
