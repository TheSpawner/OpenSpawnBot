import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME = process.env.ZK_RUNTIME || join(ROOT, 'runtime');
export const DATA = process.env.ZK_DATA || (process.platform === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'OpenSpawn Bot')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'OpenSpawn Bot')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'openspawn-bot'));
mkdirSync(join(DATA, 'cache'), { recursive: true });

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' };

export async function http(url, { timeout = 8000, headers = {}, method = 'GET', body, raw = false } = {}) {
  let response = await fetch(url, { method, body, headers: { ...HEADERS, ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if ([429, 502, 503, 504].includes(response.status) && method === 'GET') {
    await sleep(700 + Math.random() * 500);
    response = await fetch(url, { method, body, headers: { ...HEADERS, ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  }
  if (raw) return response;
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response;
}
export const getJSON = async (url, opts) => (await http(url, opts)).json();
export const getText = async (url, opts) => (await http(url, opts)).text();

const key = value => createHash('sha1').update(value).digest('hex');
export function cached(namespace, ttl, fn, keep = () => true) {
  return async (...args) => {
    const file = join(DATA, 'cache', `${namespace}-${key(JSON.stringify(args))}.json`);
    try {
      if (existsSync(file)) {
        const hit = JSON.parse(readFileSync(file, 'utf8'));
        if (Date.now() - hit.at < ttl) return hit.value;
      }
    } catch {}
    const value = await fn(...args);
    try { if (keep(value)) writeFileSync(file, JSON.stringify({ at: Date.now(), value })); } catch {}
    return value;
  };
}

export const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function siteOf(url) {
  const parts = hostOf(url).split('.');
  const tail = parts.slice(-2).join('.');
  return /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(tail) ? parts.slice(-3).join('.') : tail;
}

export const clean = text => String(text || '')
  .replace(/\[(?:\d+|[a-z]|citation needed|note \d+|edit)\]/gi, '')
  .replace(/\s+/g, ' ')
  .trim();

const ABBR = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|U\.S|U\.K|Inc|Ltd|Co|Corp|No|Fig|approx|est|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Gen|Gov|Sen|Rep|Mt|ca|cf)\.$/i;
export function sentences(text) {
  const out = [];
  let buffer = '';
  for (const piece of clean(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/)) {
    buffer = buffer ? buffer + ' ' + piece : piece;
    if (ABBR.test(buffer) || /\b[A-Z]\.$/.test(buffer)) continue;
    out.push(buffer);
    buffer = '';
  }
  if (buffer) out.push(buffer);
  return out.filter(s => s.length > 1);
}

export const words = text => String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

const STOP = new Set('a an the of in on at to for from by with and or but is are was were be been being do does did what which who whom whose when where why how this that these those it its as into about than then there their them they he she his her i me my we our you your can could should would will shall may might must not no yes if so such also just only very more most less much many some any all each every other another one two please tell show give find me us know want need like get got have has had s t'.split(' '));
export const keywords = text => words(text).filter(w => !STOP.has(w) && w.length > 1);

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

export function readJSON(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export const today = () => new Date().toISOString().slice(0, 10);
export const longDate = () => new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
