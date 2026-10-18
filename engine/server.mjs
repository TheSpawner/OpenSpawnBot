import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, DATA, readJSON, writeJSON } from './util.mjs';
import { answer, warmUp } from './brain.mjs';
import * as mouth from './mouth.mjs';
import { catalogue } from './tools/index.mjs';
import { setKeys, providerHealth, resume } from './search.mjs';
import { snapshot as trustTable } from './trust.mjs';
import { models as reflexModels, fetched as encoderBytes, cached as encodersCached } from './reflex.mjs';
import * as runtime from './runtime.mjs';
import { prepareHelpers } from './os/native.mjs';
import { describe as describeBrowser } from './os/browser.mjs';

const UI = join(ROOT, 'ui');
const THREADS = join(DATA, 'threads');
const PORT = Number(process.env.ZK_PORT || runtime.config.port);
setKeys(runtime.config.searchKeys || {});
const publicConfig = () => { const { searchKeys = {}, ...rest } = runtime.config; return { ...rest, searchKeys: Object.fromEntries(Object.entries(searchKeys).map(([k, v]) => [k, Boolean(v)])) }; };
mouth.config.endpoint = `http://127.0.0.1:${runtime.config.llmPort}/v1`;

const threads = new Map();
if (existsSync(THREADS)) for (const f of readdirSync(THREADS)) if (f.endsWith('.json')) { const t = readJSON(join(THREADS, f), null); if (t?.id) threads.set(t.id, t); }
const save = thread => writeJSON(join(THREADS, `${thread.id}.json`), thread);

const tasks = new Map();
const status = { reflex: 'loading', llm: 'starting', search: 'starting', warmMs: null, errors: [] };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const readBody = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

const summary = t => ({ id: t.id, title: t.title, updated: t.updated, turns: t.turns.length, running: t.turns.some(x => x.status === 'running') });

function emitTo(task, event) {
  task.events.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of task.listeners) res.write(line);
}

async function startTask(prompt, threadId, mode = 'auto') {
  let thread = threadId && threads.get(threadId);
  if (!thread) {
    thread = { id: randomUUID().slice(0, 8), title: prompt.replace(/\s+/g, ' ').slice(0, 64), created: Date.now(), updated: Date.now(), turns: [] };
    threads.set(thread.id, thread);
  }
  const taskId = randomUUID().slice(0, 12);
  const turn = { id: taskId, prompt, mode, status: 'running', started: Date.now(), events: [] };
  thread.turns.push(turn);
  thread.updated = Date.now();
  const history = thread.turns.filter(t => t.status === 'done' && t.result).slice(-6).map(t => ({ question: t.result.question || t.prompt, answer: t.result.answer, mode: t.result.mode }));
  const controller = new AbortController();
  const task = { id: taskId, threadId: thread.id, events: [], listeners: new Set(), controller, done: false, approvals: new Map() };
  const confirm = request => new Promise(resolve => {
    if (runtime.config.approvals === 'auto') { emitTo(task, { type: 'confirmed', id: null, approved: true, auto: true, title: request.title }); return resolve(true); }
    const id = randomUUID().slice(0, 8);
    const settle = approved => { if (!task.approvals.has(id)) return; task.approvals.delete(id); clearTimeout(timer); emitTo(task, { type: 'confirmed', id, approved }); resolve(approved); };
    const timer = setTimeout(() => settle(false), 5 * 60_000);
    task.approvals.set(id, settle);
    controller.signal.addEventListener('abort', () => settle(false), { once: true });
    emitTo(task, { type: 'confirm', id, ...request });
  });
  tasks.set(taskId, task);

  (async () => {
    try {
      const result = await answer({ prompt, history, mode }, { signal: controller.signal, confirm, emit: event => { if (event.type !== 'token') turn.events.push(event); emitTo(task, event); } });
      turn.result = result;
      turn.status = 'done';
      emitTo(task, { type: 'done', result });
    } catch (error) {
      turn.status = controller.signal.aborted ? 'stopped' : 'failed';
      turn.error = controller.signal.aborted ? 'Stopped.' : error.message;
      emitTo(task, { type: 'error', error: turn.error });
      if (!controller.signal.aborted) console.error(error);
    } finally {
      turn.ms = Date.now() - turn.started;
      thread.updated = Date.now();
      task.done = true;
      for (const res of task.listeners) res.end();
      save(thread);
      setTimeout(() => tasks.delete(taskId), 5 * 60_000);
    }
  })();
  return { taskId, threadId: thread.id };
}

const ENCODER_BYTES = 215e6;
let setup = null;
function planSetup() {
  const need = runtime.missing();
  const encoders = !encodersCached();
  const total = need.reduce((sum, item) => sum + (runtime.SIZES[item] || 0), 0) + (encoders ? ENCODER_BYTES : 0);
  setup = total ? { total, encoders } : null;
}
function setupStatus(h) {
  if (!setup) return null;
  const rt = runtime.state;
  const received = Math.min(setup.total, rt.downloaded + (rt.download?.received || 0) + (setup.encoders ? encoderBytes() : 0));
  const label = rt.download?.label?.startsWith('llama.cpp') ? 'the AI engine' : /vision/.test(rt.download?.label || '') ? 'the vision add-on' : rt.download?.label ? 'the language model' : 'the fact-checking models';
  return { total: setup.total, received, label, error: rt.download?.error || null, done: h.llm === 'ready' && h.reflex === 'ready' };
}

async function health() {
  const [llm, search, browser] = await Promise.all([mouth.health(), runtime.searchUp(), describeBrowser().catch(() => null)]);
  const rt = runtime.state;
  const h = { llm: llm.ok ? 'ready' : rt.download ? 'downloading' : rt.llm, model: runtime.MODEL.name, context: rt.context || llm.context, vision: rt.vision, backend: rt.backend, missing: runtime.missing(), download: rt.download, contextSteps: runtime.CONTEXT_STEPS, nativeContext: runtime.MODEL.nativeContext, browser, search: search ? 'ready' : ['starting', 'installing'].includes(status.search) ? status.search : 'fallback', reflex: status.reflex, warmMs: status.warmMs, errors: [rt.error, ...status.errors].filter(Boolean) };
  h.setup = setupStatus(h);
  return h;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'forbidden host' });
  if (path.startsWith('/api/') && req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'forbidden origin' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
  }
  try {
    if (path === '/api/ping') return send(res, 200, { ok: true, app: 'openspawn-bot' });
    if (path === '/api/quit' && req.method === 'POST') { send(res, 200, { ok: true }); return quit(0); }
    if (path === '/api/state') {
      return send(res, 200, { threads: [...threads.values()].sort((a, b) => b.updated - a.updated).map(summary), health: await health(), tools: catalogue(), config: publicConfig(), searchProviders: providerHealth(), encoders: reflexModels });
    }
    if (path === '/api/threads' && req.method === 'DELETE') {
      let removed = 0;
      for (const [id, thread] of threads) {
        if (thread.turns?.some(t => t.status === 'running')) continue;
        threads.delete(id);
        const file = join(THREADS, `${id}.json`);
        if (existsSync(file)) unlinkSync(file);
        removed++;
      }
      return send(res, 200, { ok: true, removed });
    }
    if (path.startsWith('/api/thread/')) {
      const id = path.split('/').pop();
      if (!/^[\w-]{1,64}$/.test(id)) return send(res, 400, { error: 'bad chat id' });
      if (req.method === 'DELETE') {
        threads.delete(id);
        const file = join(THREADS, `${id}.json`);
        if (existsSync(file)) unlinkSync(file);
        return send(res, 200, { ok: true });
      }
      const thread = threads.get(id);
      return thread ? send(res, 200, thread) : send(res, 404, { error: 'no such chat' });
    }
    if (path === '/api/ask' && req.method === 'POST') {
      const { prompt, threadId, mode } = await readBody(req);
      if (!prompt?.trim()) return send(res, 400, { error: 'empty prompt' });
      if ((await health()).llm !== 'ready') return send(res, 503, { error: 'The language model is still starting. Give it a few seconds.' });
      return send(res, 200, await startTask(prompt.trim(), threadId, ['research', 'act', 'chat'].includes(mode) ? mode : 'auto'));
    }
    if (path.startsWith('/api/stream/')) {
      const task = tasks.get(path.split('/').pop());
      if (!task) return send(res, 404, { error: 'no such task' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      for (const event of task.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (task.done) return res.end();
      task.listeners.add(res);
      req.on('close', () => task.listeners.delete(res));
      return;
    }
    if (path === '/api/approve' && req.method === 'POST') {
      const { taskId, id, approve } = await readBody(req);
      const settle = tasks.get(taskId)?.approvals.get(id);
      if (!settle) return send(res, 404, { error: 'that request is no longer waiting' });
      settle(Boolean(approve));
      return send(res, 200, { ok: true });
    }
    if (path.startsWith('/api/media/')) {
      const name = decodeURIComponent(path.slice('/api/media/'.length));
      const file = join(DATA, 'media', name);
      if (!/^[\w.-]+\.(png|jpe?g|webp)$/i.test(name) || !existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, readFileSync(file), MIME[extname(file)] || 'image/png');
    }
    if (path === '/api/stop' && req.method === 'POST') {
      const { taskId } = await readBody(req);
      for (const task of tasks.values()) if (!task.done && (!taskId || task.id === taskId)) task.controller.abort();
      return send(res, 200, { ok: true });
    }
    if (path === '/api/trust') return send(res, 200, trustTable());
    if (path === '/api/download' && req.method === 'POST') {
      runtime.downloadMissing().then(r => { if (r.ok) runtime.startLLM(); });
      return send(res, 200, { ok: true, missing: runtime.missing() });
    }
    if (path === '/api/config' && req.method === 'POST') {
      const changes = await readBody(req);
      if (String(changes.context) === String(runtime.MODEL.nativeContext)) changes.context = 'max';
      const restart = changes.context != null && String(changes.context) !== String(runtime.config.context);
      if (changes.searchKeys) {
        const current = { ...(runtime.config.searchKeys || {}) };
        for (const [k, v] of Object.entries(changes.searchKeys)) if (['brave', 'tavily', 'serper'].includes(k) && typeof v === 'string' && v.trim()) current[k] = v.trim() === '-' ? '' : v.trim();
        changes.searchKeys = current;
        setKeys(current);
      }
      runtime.saveConfig(Object.fromEntries(Object.entries(changes).filter(([k]) => ['context', 'approvals', 'searchKeys'].includes(k))));
      if (restart) runtime.restartLLM().then(r => { if (!r.ok) status.errors.push(r.error); });
      return send(res, 200, { ok: true, restarting: restart });
    }
    const file = normalize(join(UI, path === '/' ? 'index.html' : decodeURIComponent(path)));
    if (!file.startsWith(UI) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, readFileSync(file), MIME[extname(file)] || 'application/octet-stream');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: error.message });
  }
});

function quit(code = 0) {
  runtime.shutdown();
  setTimeout(() => process.exit(code), 300);
}

server.on('error', async error => {
  if (error.code !== 'EADDRINUSE') throw error;
  const ours = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
  console.log(ours ? `OpenSpawn Bot is already running at http://127.0.0.1:${PORT}` : `Port ${PORT} is used by another program. Set "port" in data/config.json to a free one.`);
  process.exit(ours ? 0 : 1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenSpawn Bot → http://127.0.0.1:${PORT}`);
  startHelpers();
});

const owner = Number(process.env.ZK_OWNER_PID || 0);
if (owner) setInterval(() => { try { process.kill(owner, 0); } catch { quit(0); } }, 2000).unref();

function startHelpers() {
planSetup();
const ready = r => console.log(`· language model ready (${runtime.state.context || '?'} tokens per slot${runtime.state.vision ? ', vision' : ''})`);
runtime.startLLM().then(async r => {
  if (r.ok) return ready(r);
  if (!r.missing) return console.error(r.error);
  console.log(`· first run: downloading ${runtime.missing().join(', ')}`);
  const d = await runtime.downloadMissing();
  if (!d.ok) return console.error(d.error);
  const s = await runtime.startLLM();
  if (s.ok) ready(s); else console.error(s.error);
});
const searchReady = r => { status.search = r.ok ? 'ready' : 'fallback'; if (r.ok) resume('searxng'); return r; };
(async () => {
  if (!runtime.searchInstalled()) {
    status.search = 'installing';
    console.log('· installing SearXNG');
    const i = await runtime.installSearch();
    if (!i.ok) { status.search = 'fallback'; return console.error(i.error); }
  }
  const r = searchReady(await runtime.startSearch());
  if (!r.ok) console.error(r.error); else console.log('· search ready');
})();
prepareHelpers().then(r => { if (!r.ok) { status.errors.push(r.error); console.error(r.error); } });
warmUp().then(ms => { status.reflex = 'ready'; status.warmMs = ms; console.log(`· reflex models ready (${ms} ms)`); }).catch(error => { status.reflex = 'failed'; status.errors.push(error.message); console.error(error); });
let healing = false;
const misses = { llm: 0, search: 0 };
setInterval(async () => {
  if (healing) return;
  healing = true;
  try {
    const llmGone = runtime.state.llm === 'crashed' || (runtime.state.backend === 'already running' && !(await runtime.llmUp(8000)) && ++misses.llm >= 3);
    if (runtime.state.llm === 'ready' && runtime.state.backend !== 'already running') misses.llm = 0;
    if (llmGone) { misses.llm = 0; console.log('· language model went away; restarting it'); await runtime.startLLM(); }
    if (status.search === 'installing') misses.search = 0;
    else if (!(await runtime.searchUp(5000))) { if (++misses.search >= 2) { misses.search = 0; searchReady(await runtime.startSearch()); } } else misses.search = 0;
  } finally { healing = false; }
}, 15000).unref();
}
