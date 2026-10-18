import { parseHTML } from 'linkedom';
import { getJSON, getText, http, cached, MINUTE, withTimeout, hostOf } from './util.mjs';

const SEARXNG = process.env.ZK_SEARXNG || 'http://127.0.0.1:8888';
export const keys = { brave: process.env.BRAVE_API_KEY || '', tavily: process.env.TAVILY_API_KEY || '', serper: process.env.SERPER_API_KEY || '' };
export function setKeys(next = {}) { for (const k of Object.keys(keys)) if (typeof next[k] === 'string') keys[k] = next[k].trim(); }

const decode = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x27;/g, "'").replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function searxng(query, { time } = {}) {
  const params = new URLSearchParams({ q: query, format: 'json', categories: 'general', language: 'en' });
  if (time) params.set('time_range', time);
  const data = await getJSON(`${SEARXNG}/search?${params}`, { timeout: 7000 });
  return (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content || '', date: r.publishedDate || null, engine: 'searxng', via: (r.engines || []).join('+') }));
}

function unwrapDuck(url) {
  const wrapped = String(url).match(/[?&]uddg=([^&]+)/);
  let u = wrapped ? decodeURIComponent(wrapped[1]) : String(url);
  if (u.startsWith('//')) u = 'https:' + u;
  return u;
}
async function duckduckgo(query, { time } = {}) {
  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  if (time) params.set('df', { day: 'd', week: 'w', month: 'm', year: 'y' }[time] || '');
  const html = await getText(`https://html.duckduckgo.com/html/?${params}`, { timeout: 6000 });
  if (/anomaly-modal|challenge-form/.test(html)) throw new Error('CAPTCHA');
  const { document } = parseHTML(html);
  return [...document.querySelectorAll('.result')].filter(r => !r.classList.contains('result--ad')).map(r => {
    const link = r.querySelector('.result__a');
    return { title: link?.textContent?.trim() || '', url: unwrapDuck(link?.getAttribute('href') || ''), snippet: r.querySelector('.result__snippet')?.textContent?.trim() || '', date: null, engine: 'duckduckgo' };
  }).filter(r => r.url.startsWith('http') && !hostOf(r.url).endsWith('duckduckgo.com'));
}
async function duckduckgoLite(query) {
  const html = await getText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=us-en`, { timeout: 6000 });
  if (/anomaly|challenge/.test(html) && !/result-link/.test(html)) throw new Error('CAPTCHA');
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll('a.result-link')];
  const snippets = [...document.querySelectorAll('td.result-snippet')];
  return links.map((a, i) => ({ title: a.textContent.trim(), url: unwrapDuck(a.getAttribute('href') || ''), snippet: snippets[i]?.textContent?.trim() || '', date: null, engine: 'duckduckgo' })).filter(r => r.url.startsWith('http') && !hostOf(r.url).endsWith('duckduckgo.com'));
}

async function wikipedia(query) {
  const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, format: 'json', srlimit: '3', srprop: 'snippet|timestamp', srinfo: 'suggestion' });
  const data = await getJSON(`https://en.wikipedia.org/w/api.php?${params}`, { timeout: 5000 });
  return (data.query?.search || []).map(r => ({
    title: r.title + ' - Wikipedia', url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: decode(r.snippet), date: r.timestamp, engine: 'wikipedia'
  }));
}

export async function googleNews(query) {
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`, { timeout: 6000 });
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map(([, block]) => {
    const tag = name => decode((block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1]);
    const title = tag('title'), source = tag('source');
    return { title, url: tag('link'), snippet: `${title} (${source})`, date: tag('pubDate'), engine: 'news', publisher: source };
  });
}
async function bingNews(query) {
  const xml = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`, { timeout: 6000 });
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map(([, item]) => {
    const tag = name => decode((item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]);
    let url = tag('link');
    const real = url.match(/[?&]url=([^&]+)/);
    if (real) url = decodeURIComponent(real[1]);
    return { title: tag('title'), url, snippet: tag('description'), date: tag('pubDate') || null, engine: 'bing-news' };
  }).filter(r => /^https?:\/\//.test(r.url));
}

async function brave(query, { time } = {}) {
  const params = new URLSearchParams({ q: query, count: '15' });
  if (time) params.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[time] || '');
  const data = await getJSON(`https://api.search.brave.com/res/v1/web/search?${params}`, { timeout: 7000, headers: { 'X-Subscription-Token': keys.brave, accept: 'application/json' } });
  return (data.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: decode(r.description), date: r.age || null, engine: 'brave' }));
}
async function tavily(query) {
  const response = await http('https://api.tavily.com/search', { method: 'POST', timeout: 9000, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: keys.tavily, query, max_results: 10, search_depth: 'basic' }) });
  const data = await response.json();
  return (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content || '', date: r.published_date || null, engine: 'tavily' }));
}
async function serper(query) {
  const response = await http('https://google.serper.dev/search', { method: 'POST', timeout: 7000, headers: { 'content-type': 'application/json', 'X-API-KEY': keys.serper }, body: JSON.stringify({ q: query, num: 15 }) });
  const data = await response.json();
  return (data.organic || []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet || '', date: r.date || null, engine: 'serper' }));
}

const PROVIDERS = {
  brave: { run: brave, keyed: 'brave' }, tavily: { run: tavily, keyed: 'tavily' }, serper: { run: serper, keyed: 'serper' },
  searxng: { run: searxng }, duckduckgo: { run: duckduckgo }, 'duckduckgo-lite': { run: duckduckgoLite, backupFor: 'duckduckgo' },
  wikipedia: { run: wikipedia, encyclopedia: true }, 'bing-news': { run: bingNews, news: true }, 'google-news': { run: googleNews, news: true }
};

const health = {};
const usable = name => { const h = health[name]; return !h || Date.now() > h.until; };
function record(name, ok) {
  const h = health[name] ||= { fails: 0, until: 0 };
  if (ok) { h.fails = 0; h.until = 0; return; }
  h.fails++;
  if (h.fails >= 2) h.until = Date.now() + Math.min(30 * MINUTE, 60_000 * 2 ** (h.fails - 2));
}
export const resume = name => { delete health[name]; };
export const providerHealth = () => Object.fromEntries(Object.keys(PROVIDERS).map(n => [n, PROVIDERS[n].keyed && !keys[PROVIDERS[n].keyed] ? 'no key' : usable(n) ? 'ok' : `paused ${Math.ceil((health[n].until - Date.now()) / 60000)} min`]));

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref|fbclid|gclid|mc_)/.test(p)) u.searchParams.delete(p);
    return (u.hostname.replace(/^(www|m)\./, '') + u.pathname.replace(/\/$/, '') + u.search).toLowerCase();
  } catch { return url; }
}

function fuse(lists) {
  const merged = new Map();
  for (const list of lists) {
    list.forEach((result, rank) => {
      const id = normalizeUrl(result.url);
      const existing = merged.get(id);
      const score = 1 / (60 + rank);
      if (existing) {
        existing.score += score;
        existing.engines.add(result.engine);
        if ((result.snippet || '').length > (existing.snippet || '').length) existing.snippet = result.snippet;
        existing.date ||= result.date;
      } else merged.set(id, { ...result, score, engines: new Set([result.engine]) });
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).map(r => ({ ...r, engines: [...r.engines] }));
}

const searchUncached = async (query, options = {}) => {
  const wanted = Object.entries(PROVIDERS).filter(([name, p]) =>
    (!p.keyed || keys[p.keyed]) && !p.backupFor && (options.news ? true : !p.news) && usable(name));
  const runs = wanted.map(([name, p]) => {
    const go = async () => {
      try {
        let results = await p.run(query, options);
        if (!results.length) throw new Error('no results');
        record(name, true);
        return { name, results, kind: p.encyclopedia ? 'encyclopedia' : p.news ? 'news' : 'web' };
      } catch (error) {
        record(name, false);
        const backup = Object.entries(PROVIDERS).find(([, b]) => b.backupFor === name);
        if (backup && usable(backup[0])) {
          try { const results = await backup[1].run(query, options); if (results.length) { record(backup[0], true); return { name: backup[0], results, kind: 'web' }; } } catch { record(backup[0], false); }
        }
        return { name, results: [], error: error.message, kind: 'web' };
      }
    };
    return withTimeout(go(), 8000, { name, results: [], error: 'timeout', kind: 'web' });
  });
  const done = runs.map(() => null);
  await new Promise(resolve => {
    let webAnswers = 0, finished = 0, grace = null, patience = null;
    runs.forEach((run, i) => run.then(result => {
      done[i] = result;
      finished++;
      if (result.results.length && result.kind !== 'encyclopedia') webAnswers++;
      if (finished === runs.length) { clearTimeout(grace); clearTimeout(patience); return resolve(); }
      if (webAnswers >= 2 && !grace) grace = setTimeout(resolve, 600);
      else if (webAnswers === 1 && !patience) patience = setTimeout(resolve, 1500);
    }));
  });
  const settled = done.map((s, i) => s || { name: wanted[i][0], results: [], error: 'too slow' });
  return { results: fuse(settled.map(s => s.results)), providers: settled.map(s => ({ name: s.name, count: s.results.length, error: s.error })) };
};

const found = r => r.results.length > 0;
export const search = cached('search2', 30 * MINUTE, searchUncached, found);
export const searchFresh = cached('search2-fresh', 5 * MINUTE, searchUncached, found);
export const newsSearch = cached('news2', 10 * MINUTE, q => searchUncached(q, { news: true }), found);

export const spell = cached('spell', 7 * 24 * 60 * MINUTE, async text => {
  const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: text, format: 'json', srlimit: '1', srinfo: 'suggestion', srprop: '' });
  const data = await getJSON(`https://en.wikipedia.org/w/api.php?${params}`, { timeout: 5000 }).catch(() => null);
  return data?.query?.searchinfo?.suggestion || data?.query?.search?.[0]?.title || null;
});
