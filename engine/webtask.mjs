import * as B from './os/browser.mjs';
import * as P from './os/platform.mjs';
import * as reflex from './reflex.mjs';
import { search } from './search.mjs';
import { hostOf, siteOf, words, http, cached, DAY } from './util.mjs';

const VERB = '(?:open|go|visit|navigate|browse|head|take|pull|bring|load|search|look|find|type|enter|put|play|watch|listen|stream|click|tap|press|hit|select|choose|scroll)';
const SPLIT = new RegExp(`\\s*(?:,\\s*(?:and\\s+)?(?:then\\s+)?|\\s+(?:and\\s+then|then|and)\\s+)(?=${VERB}\\b)`, 'i');
const IN_BROWSER = /\s+(?:in|on|with|using)\s+(?:the\s+|my\s+|a\s+|your\s+|its\s+)?(?:own\s+)?(?:web\s+)?browser\b.*$/i;
const DOMAIN = /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
const NOT_A_SITE = /^(?:the |a |an |my |your |this |that |these |those |some |all |every |it$|them$)|\b(folders?|director(?:y|ies)|files?|apps?|applications?|programs?|settings|terminal|command prompt|powershell|notepad|explorer|finder|desktop|documents|downloads|pictures|computer|pc|laptop|drives?|disk|screen|windows?|calculator|clipboard|recycle bin|trash|results?|videos?|songs?|links?|button|page|tab)\b/i;
const unquote = s => String(s || '').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
const isSite = s => { const t = unquote(s); return Boolean(t) && (DOMAIN.test(t) || (t.split(/\s+/).length <= 3 && /^[\p{L}\p{N}][\p{L}\p{N}.&' -]*$/u.test(t) && !NOT_A_SITE.test(t))); };
const TOPIC = /\b(news|information|info|details|facts|updates?|articles?|data|reviews?|opinions?|thoughts|research|papers?|stats|statistics|history|more|everything|anything|something)\s*$/i;
const FIRST = /^(?:the\s+)?(?:first|top|1st)(?:\s+(?:one|video|song|result|track|link|hit|item))?$/i;
const NOT_FOUND = /\b(not found|404|page not found|doesn.t exist|no longer available|error)\b/i;

function clause(raw, ctx) {
  let c = String(raw).trim().replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|i'?d like you to\s+|go ahead and\s+)+/i, '').replace(/\s+(?:for me|please)$/i, '').replace(/[.!?]+$/, '').trim();
  const web = IN_BROWSER.test(c);
  c = c.replace(IN_BROWSER, '').trim();
  let m;
  if ((m = c.match(/^(?:play|put on|watch|listen to|stream)\s+(.+?)(?:\s+(?:on|from|in)\s+([^\s].{0,40}))?$/i)) && (!m[2] || isSite(m[2]))) {
    if (FIRST.test(m[1]) || /^(?:it|that|this|one)$/i.test(m[1])) return { op: 'play', first: true, site: m[2] && unquote(m[2]) };
    return { op: 'play', query: unquote(m[1].replace(/^(?:some|a|an|the)\s+/i, '')), site: m[2] && unquote(m[2]) };
  }
  if ((m = c.match(/^(?:search|look\s+up|lookup|check)\s+(?:on\s+|in\s+)?(\S+(?:\s+\S+){0,2}?)\s+for\s+(.+)$/i)) && isSite(m[1])) return { op: 'search', site: unquote(m[1]), query: unquote(m[2]) };
  if ((m = c.match(/^(search(?:\s+for)?|look\s+up|look\s+for|lookup|find)\s+(.+?)\s+(on|in|at|using|via)\s+(\S+(?:\s+\S+){0,2})$/i)) && isSite(m[4]) && !/^(?:the\s+)?search\b/i.test(m[4])
    && (DOMAIN.test(unquote(m[4])) || (/^search/i.test(m[1]) && m[3].toLowerCase() !== 'in' && !/\s/.test(unquote(m[4])) && !TOPIC.test(m[2])))) return { op: 'search', site: unquote(m[4]), query: unquote(m[2]), form: 'suffix' };
  if (ctx.browser && (m = c.match(/^(?:search(?:\s+for)?|look\s+up|look\s+for)\s+(.+?)(?:\s+(?:in|into|on|using)\s+(?:the\s+)?(?:search(?:\s*(?:box|bar|field))?|it|there|(?:the\s+)?(?:site|page)))?(?:\s+and\s+(?:press|hit)\s+enter)?$/i))) return { op: 'search', query: unquote(m[1]) };
  if (ctx.browser && (m = c.match(/^(?:type|enter|put|write|input)\s+(.+?)\s+(?:in|into|in the|on)\s+(?:the\s+)?(.+?)(\s+and\s+(?:press|hit)\s+enter|\s+and\s+search)?$/i))) {
    if (/search/i.test(m[2])) return { op: 'search', query: unquote(m[1]) };
    return { op: 'type', text: unquote(m[1]), field: m[2].replace(/\s+(?:box|field|bar|input)$/i, ''), submit: Boolean(m[3]) };
  }
  if (/^(?:open|launch|start|bring\s+up|pull\s+up)(?:\s+up)?\s+(?:my|the|a|your|its)?\s*(?:own\s+)?(?:web\s+)?browser$/i.test(c)) return { op: 'browser' };
  if ((m = c.match(/^(?:open(?:\s+up)?|go\s+to|goto|visit|navigate\s+to|browse\s+to|head\s+(?:over\s+)?to|take\s+me\s+to|pull\s+up|bring\s+up|load)\s+(?:the\s+)?(?:website\s+|site\s+|web\s*page\s+)?(.+?)(?:\s+(?:website|site|web\s*page|homepage|home\s+page))?$/i))) {
    const target = unquote(m[1]);
    if (ctx.browser && FIRST.test(target)) return { op: 'first' };
    if (DOMAIN.test(target)) return { op: 'open', site: target, web: true };
    if (isSite(target)) return { op: 'open', site: target, web };
    return null;
  }
  if (ctx.browser && (m = c.match(/^(?:click|tap|press|hit|select|choose)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab))?$/i))) return FIRST.test(m[1]) ? { op: 'first' } : { op: 'click', target: unquote(m[1]) };
  if (ctx.browser && (m = c.match(/^scroll(?:\s+(?:the\s+page\s+)?(down|up))?\b/i))) return { op: 'scroll', dir: (m[1] || 'down').toLowerCase() };
  return null;
}

const label = op => ({
  browser: () => 'Open its own browser window',
  open: () => `Open ${op.site} in its own browser window`,
  search: () => `Search ${op.site || 'the site'} for “${op.query}”`,
  play: () => op.first ? 'Play the first result' : `Play “${op.query}”${op.site ? ` on ${op.site}` : ''}`,
  first: () => 'Open the first result',
  type: () => `Type “${op.text}” into the ${op.field}${op.submit ? ' and press Enter' : ''}`,
  click: () => `Click “${op.target}”`,
  scroll: () => `Scroll ${op.dir}`
}[op.op]());

function parse(goal) {
  const ops = []; let browser = false;
  for (const part of String(goal).split(SPLIT).map(s => s.trim()).filter(Boolean)) {
    const op = clause(part, { browser });
    if (!op) return null;
    ops.push(op);
    if (op.op !== 'scroll') browser = true;
  }
  const kept = ops.filter((op, i) => !(op.op === 'browser' && i < ops.length - 1));
  return kept.length ? kept : null;
}
export function isWebTask(message) {
  const ops = parse(message);
  if (!ops) return false;
  if (ops.length === 1 && ops[0].form === 'suffix') return false;
  return ops.length > 1 || !['open', 'browser'].includes(ops[0].op) || ops[0].op === 'browser' || ops[0].web || DOMAIN.test(ops[0].site);
}
export async function compile(goal) {
  const ops = parse(goal);
  if (!ops) return null;
  if (ops.length === 1 && ops[0].op === 'open' && !ops[0].web && !DOMAIN.test(ops[0].site) && await P.findApp(ops[0].site).catch(() => null)) return null;
  return ops.map(op => ({ ...op, step: label(op) }));
}
export function interpret(step, { browser = false } = {}) {
  const op = clause(step, { browser }) || (/\bhttps?:\/\/\S+/i.test(step) && /\b(open|go|visit|navigate|load|browse)\b/i.test(step) ? { op: 'open', site: step.match(/https?:\/\/[^\s"'”)]+/i)[0], web: true } : null);
  return op ? { ...op, step } : null;
}

let lastSite = null;
export function begin() { lastSite = null; }
const resolved = new Map();
export async function resolveSite(name) {
  const n = unquote(name).replace(/^the\s+/i, '');
  if (DOMAIN.test(n)) return /^https?:/i.test(n) ? n : 'https://' + n;
  const key = n.toLowerCase();
  if (resolved.has(key)) return resolved.get(key);
  const slug = key.replace(/[^\p{L}\p{N}]/gu, '');
  const parts = words(n);
  let url = await officialSite(n).catch(() => null);
  if (url) { resolved.set(key, url); return url; }
  try {
    const runs = await Promise.all([search(n), search(`${n} official site`)].map(p => p.catch(() => ({ results: [] }))));
    const hits = runs.flatMap(r => (r.results || []).slice(0, 8).map((x, rank) => ({ url: x.url, title: String(x.title || ''), rank, host: hostOf(x.url) }))).filter(h => h.host);
    const hostname = h => new URL(h.url).hostname;
    const label = h => siteKey(h.url).split('.')[0].replace(/[^\p{L}\p{N}]/gu, '');
    const root = h => hostname(h) === siteKey(h.url) || hostname(h) === 'www.' + siteKey(h.url);
    const head = t => t.toLowerCase().split(/\s+[-|–—:·]\s+/)[0].trim();
    const inHost = h => parts.every(w => hostname(h).includes(w));
    const scored = hits.map(h => ({ h, score: (head(h.title) === key ? 5 : 0) + (label(h) === slug ? 3 : 0) + (parts.includes(label(h)) && parts.every(w => `${hostname(h)} ${h.url.toLowerCase()}`.includes(w)) ? 2 : 0) + (root(h) ? 1 : 0) + (inHost(h) ? 1 : 0) - h.rank * 0.05 }))
      .filter(x => x.score >= 2).sort((a, b) => b.score - a.score);
    if (scored.length) { const best = scored[0].h; url = label(best) === slug || inHost(best) ? `https://${hostname(best)}/` : best.url; }
  } catch {}
  url ||= `https://www.${slug}.com/`;
  resolved.set(key, url);
  return url;
}
const WIKIMEDIA = { 'user-agent': 'OpenSpawnBot/0.1 (desktop assistant; site lookup)' };
async function wikidata(query) {
  for (let attempt = 0; ; attempt++) {
    const r = await http(`https://www.wikidata.org/w/api.php?format=json&${query}`, { timeout: 6000, headers: WIKIMEDIA, raw: true });
    if (r.ok) return r.json();
    if (r.status !== 429 || attempt >= 2) throw new Error(`Wikidata answered ${r.status}`);
    await new Promise(done => setTimeout(done, 1500 * (attempt + 1)));
  }
}
const officialSite = cached('official-site', 30 * DAY, async name => {
  const want = name.toLowerCase();
  const found = await wikidata(`action=wbsearchentities&language=en&uselang=en&type=item&limit=7&search=${encodeURIComponent(name)}`);
  const ids = (found.search || []).filter(s => String(s.label || '').toLowerCase() === want || String(s.match?.text || '').toLowerCase() === want).map(s => s.id);
  if (!ids.length) return null;
  const items = await wikidata(`action=wbgetentities&props=claims&ids=${ids.join('|')}`);
  for (const id of ids) {
    const claims = (items.entities?.[id]?.claims?.P856 || []).filter(c => c.rank !== 'deprecated');
    const value = (claims.find(c => c.rank === 'preferred') || claims[0])?.mainsnak?.datavalue?.value;
    if (/^https?:\/\//i.test(value || '')) return value;
  }
  return null;
});
const siteKey = url => siteOf(url);
const sameSite = (a, b) => Boolean(hostOf(a)) && siteKey(a) === siteKey(b);

function aboutQuery(state, query) {
  let url = state.url; try { url = decodeURIComponent(state.url.replace(/\+/g, ' ')); } catch {}
  const hay = `${url} ${state.title} ${state.h1}`.toLowerCase();
  const terms = words(query).filter(w => w.length > 2);
  const hit = terms.filter(w => hay.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
  return !terms.length || hit / terms.length >= 0.5;
}

async function ensureOn(site) {
  lastSite = site;
  const url = await resolveSite(site);
  const now = await B.where().catch(() => null);
  if (now && sameSite(now.url, url)) { const r = await B.ready(); return { url: r.url, title: r.title, already: true }; }
  const r = await B.open(url);
  await stopIfHumanCheck(r.opened);
  return { url: r.opened, title: r.title, declined: r.declinedCookies };
}
class HumanCheck extends Error {}
async function stopIfHumanCheck(url) {
  const what = await B.humanCheck();
  if (what) throw new HumanCheck(`${hostOf(url) || 'the site'} is showing ${what} that only a person should answer — it is open in the agent's browser window for you to finish, then ask again`);
}

const browserName = () => { const w = B.which(); return w ? `${w.name}, separate profile` : 'separate profile'; };
async function freshResults(query, before = null, ms = 7000) {
  const until = Date.now() + ms; let list = [];
  while (Date.now() < until) {
    list = await B.results(query).catch(() => []);
    const top = list.slice(0, 8);
    const changed = !before?.size || top.filter(r => !before.has(r.href)).length >= Math.ceil(top.length / 2);
    if (list.length && changed && (!words(query).some(w => w.length > 2) || list.slice(0, 12).some(r => r.hit > 0))) return list;
    await new Promise(r => setTimeout(r, 400));
  }
  return list;
}
const listed = async () => new Set((await B.results('').catch(() => [])).slice(0, 12).map(r => r.href));
const topResults = async (query, before) => (await freshResults(query, before)).slice(0, 5).map(r => r.text);

export async function openSite({ site }) {
  if (!site) throw new Error('which site?');
  const r = await ensureOn(site);
  const host = hostOf(r.url);
  return { ok: true, url: r.url, title: r.title, report: r.already ? `**Already open:** ${host} (${r.title || 'page'}).` : `**Opened** ${host} in its own browser window (${browserName()}).${r.declined ? ` Declined its cookie banner (“${r.declined}”).` : ''}` };
}

export async function searchSite({ query, site }) {
  if (!query) throw new Error('search for what?');
  if (site) await ensureOn(site);
  else if (lastSite) await ensureOn(lastSite);
  const start = await B.pageState();
  const before = await listed();
  if (!/^https?:/.test(start.url)) throw new Error('no web page is open to search on; name the site');
  const host = hostOf(start.url), tried = [];
  const done = async (via, extra = '') => {
    const state = await B.pageState();
    const head = `**Searched** ${hostOf(state.url) || host} for “${query}”${via ? ' ' + via : ''}${extra}.`;
    let listing = false;
    try { const u = new URL(state.url); listing = /\/(search|results?|s|find)(\/|$)/i.test(u.pathname) || words([...u.searchParams.values()].join(' ')).some(w => words(query).includes(w)); } catch {}
    if (!listing) return { ok: true, url: state.url, title: state.title, notes: tried.join('; '), report: `${head} It went straight to the page “${state.title}”.` };
    return { ok: true, url: state.url, title: state.title, notes: tried.join('; '), items: await topResults(query, before), report: `${head} The results page is open.` };
  };
  if (aboutQuery(start, query) && /[?&](q|query|search_query|search|k|p|keywords?)=/i.test(start.url)) return done('', ' (those results were already open)');
  const landed = async (from, ms = 7000) => {
    const until = Date.now() + ms; let state = await B.pageState();
    while (Date.now() < until) {
      state = await B.pageState().catch(() => state);
      if (state.url !== from && aboutQuery(state, query) && !NOT_FOUND.test(state.title)) return { ok: true, state };
      await new Promise(r => setTimeout(r, 400));
    }
    return { ok: false, state };
  };
  for (let round = 0; round < 2; round++) {
    const fields = await B.searchFields().catch(() => []);
    for (const f of fields.slice(0, 2)) {
      try {
        await B.typeInto(f.ref, query, { submit: true });
        const url = await B.waitForUrlChange(start.url, 4000);
        await stopIfHumanCheck(url);
        const r = await landed(start.url);
        if (r.ok) return done('by typing into its search box and pressing Enter');
        tried.push(`search box: ${r.state.url === start.url ? 'the page did not change' : `the new page (${r.state.title}) is not about “${query}”`}`);
      } catch (e) { if (e instanceof HumanCheck) throw e; tried.push(`search box: ${e.message}`); }
    }
    if (fields.length || !(await B.revealSearch().catch(() => false))) break;
  }
  const addresses = [];
  try {
    const descriptor = await B.openSearchTemplate();
    if (descriptor) {
      const xml = await (await fetch(descriptor, { signal: AbortSignal.timeout(5000) })).text();
      const tag = [...xml.matchAll(/<Url\b[^>]*>/gi)].map(x => x[0]).find(t => /type=["']text\/html["']/i.test(t));
      const template = tag?.match(/template=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&');
      if (template) addresses.push(['through its own search address', template.replace(/\{searchTerms\}/g, encodeURIComponent(query)).replace(/\{startPage\??\}/g, '1').replace(/\{count\??\}/g, '20').replace(/\{language\??\}/g, 'en').replace(/\{[^}]*\?\}/g, '')]);
    }
  } catch (e) { tried.push(`search address: ${e.message}`); }
  addresses.push(['through its search page', `${new URL(start.url).origin}/search?q=${encodeURIComponent(query)}`]);
  for (const [via, url] of addresses) {
    try {
      await B.open(url); await stopIfHumanCheck(url);
      if ((await landed(start.url, 4000)).ok) return done(via);
      tried.push(`${via}: the page is not about the query`);
    } catch (e) { if (e instanceof HumanCheck) throw e; tried.push(`${via}: ${e.message}`); }
  }
  try {
    const r = await search(`site:${host} ${query}`);
    for (const hit of (r.results || []).filter(x => sameSite(x.url, start.url)).slice(0, 3)) {
      await B.open(hit.url); await stopIfHumanCheck(hit.url);
      const state = await B.pageState();
      if (!NOT_FOUND.test(state.title) && aboutQuery(state, query)) return done('', ` (its search box did not respond, so the best match from a web search of ${host} is open instead)`);
    }
    tried.push('web search: nothing on that site about it');
  } catch (e) { if (e instanceof HumanCheck) throw e; tried.push(`web search: ${e.message}`); }
  throw new Error(`could not search ${host}: ${tried.join('; ')}`);
}

export async function play({ query, site, first }) {
  let searched = null;
  if (query) {
    searched = await searchSite({ query, site: site || lastSite || 'YouTube' });
  }
  if (!query || first || (searched && !searched.items)) {
    const main = (await B.media().catch(() => [])).filter(m => m.width >= 300);
    if (main.length) return playHere(searched);
  }
  const list = await freshResults(query || '');
  if (!list.length) throw new Error('no results on this page to play');
  const media = list.filter(r => r.media);
  const pool = media.length ? media : list;
  const pick = first ? pool.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left))[0] : (query && pool.find(r => r.hit > 0)) || pool[0];
  let clicked = await B.click(pick.ref).catch(() => null);
  if (!clicked || hostOf(clicked.url) !== hostOf(pick.href) || clicked.effect === 'nothing visibly changed') { const r = await B.open(pick.href); clicked = { url: r.opened, title: r.title }; }
  const playing = await waitPlaying();
  const host = hostOf(clicked.url);
  const title = pick.text;
  const head = searched ? [searched.report.replace(' The results page is open.', '')] : [];
  if (!(await B.media().catch(() => [])).length && !playing) return { ok: true, url: clicked.url, title: clicked.title, report: [...head, `**Opened** “${title}” on ${host}. There is no audio or video on that page to play.`].join(' ') };
  if (!playing) throw new Error(`opened “${title}” but it is not playing`);
  return { ok: true, url: clicked.url, title: clicked.title, report: [...head, `**Playing** “${title}” on ${host} — checked: the ${/music|song|track|album|audio/i.test(host) ? 'track' : 'video'} is playing.`].join(' ') };
}

async function waitPlaying(ms = 12000) {
  const until = Date.now() + ms; let nudged = false;
  while (Date.now() < until) {
    const m = await B.media().catch(() => []);
    if (m.some(x => x.playing && x.time > 0)) return true;
    if (!nudged && Date.now() > until - ms * 2 / 3) { await B.playMedia().catch(() => 0); nudged = true; }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}
async function playHere(searched) {
  const page = await B.where();
  const head = searched ? [searched.report.replace(/ It went straight to the page “[^”]*”\.$| The results page is open\.$/, '')] : [];
  const title = page.title.replace(/\s+[-|–]\s+[^-|–]+$/, '');
  if (!(await waitPlaying())) throw new Error(`“${title}” is open but it is not playing`);
  return { ok: true, url: page.url, title: page.title, report: [...head, `**Playing** “${title}” on ${hostOf(page.url)} — checked: it is playing.`].join(' ') };
}

export async function openFirst() {
  const list = await B.results('');
  if (!list.length) throw new Error('no results on this page');
  const r = await B.click(list[0].ref);
  return { ok: true, url: r.url, title: r.title, report: `**Opened** “${list[0].text}” (${hostOf(r.url)}).` };
}

async function element(description, typeable) {
  const page = await B.read();
  const pool = page.elements.filter(e => (e.name || e.value) && (!typeable || /text|search|email|textarea|textbox|combobox|searchbox|url|tel|number/i.test(e.role)));
  if (!pool.length) return null;
  const scores = await reflex.rerank(description, pool.map(e => `${e.role} ${e.name || ''} ${e.value || ''}`.trim()));
  let best = 0; scores.forEach((s, i) => { if (s.logit > scores[best].logit) best = i; });
  return scores[best].logit > -6 ? pool[best] : null;
}
export async function clickText({ target }) {
  const el = await element(target, false);
  if (!el) throw new Error(`nothing on the page looks like “${target}”`);
  const r = await B.click(el.ref);
  if (r.effect === 'nothing visibly changed') throw new Error(`clicked “${el.name}” but nothing changed on the page`);
  return { ok: true, url: r.url, title: r.title, report: `**Clicked** “${el.name}” — ${r.effect}${r.effect === 'the page changed' ? ` to ${r.title || hostOf(r.url)}` : ''}.` };
}
export async function typeText({ field, text, submit }) {
  const el = await element(field || 'text box', true);
  if (!el) throw new Error(`no field like “${field}” on this page`);
  const r = await B.typeInto(el.ref, text, { submit: Boolean(submit) });
  return { ok: true, url: r.url, report: `**Typed** “${text}” into ${el.name || field}${submit ? ' and pressed Enter' : ''} — checked: the field shows it.` };
}
export async function scroll({ dir }) {
  const r = await B.scrollBy(dir === 'up' ? -800 : 800);
  return { ok: true, report: `**Scrolled** ${dir || 'down'}.`, output: `scrolled to ${r.scrolledTo}` };
}

async function showBrowser() {
  await B.where();
  return { ok: true, report: `**Opened** its own browser window (${browserName()}).` };
}
const RUN = { browser: showBrowser, open: openSite, search: searchSite, play, first: openFirst, click: clickText, type: typeText, scroll };
export const TOOL_OF = { browser: 'browser_open_site', open: 'browser_open_site', search: 'browser_search_site', play: 'browser_play', first: 'browser_open_first_result', click: 'browser_click_text', type: 'browser_type', scroll: 'browser_scroll' };
export async function runOp(op) { await B.focus().catch(() => null); return RUN[op.op](op); }

const IRREVERSIBLE = /\b(submit|send|post|publish|buy|purchase|pay|checkout|check out|place order|order now|confirm|delete|remove|unsubscribe|subscribe|sign up|register|transfer|book now|reserve|donate|tweet|reply|share now|accept|agree)\b/i;
const tool = (id, title, description, examples, properties, required, run, risk = 'harmless') => ({ id, title, family: 'Browser', description, examples, risk, agentOnly: true, parameters: { type: 'object', properties, required }, describe: a => `${title}: ${JSON.stringify(a).slice(0, 120)}`, run: async args => { const r = await run(args); return { ...r, text: r.report }; } });
export const webTools = [
  tool('browser_open_site', 'Open site', 'Open a website by name or address in the agent\'s own browser window (a separate profile, never the user\'s) and check that it loaded.', ['open youtube', 'go to amazon', 'open wikipedia in the browser'], { site: { type: 'string', description: 'site name or address, e.g. YouTube or github.com' } }, ['site'], openSite),
  tool('browser_search_site', 'Search a site', 'Search inside a website the way a person does: type into its search box and press Enter, and check that a results page about the query opened.', ['search youtube for lofi music', 'type cats into the search box and press enter', 'search amazon for headphones'], { query: { type: 'string' }, site: { type: 'string', description: 'site to search, or empty for the page that is open' } }, ['query'], searchSite),
  tool('browser_play', 'Play', 'Find and play a video or song (YouTube unless a site is named) and check that it is really playing.', ['play some jazz', 'play the first video', 'put on lofi music'], { query: { type: 'string', description: 'what to play, or empty for the first result on the page' }, site: { type: 'string' } }, [], args => play({ ...args, first: !args.query })),
  tool('browser_open_first_result', 'Open first result', 'Open the first result on the results page that is showing.', ['open the first result', 'click the top link'], {}, [], openFirst),
  tool('browser_click_text', 'Click on page', 'Click the thing on the web page that a description names, and check that the page changed.', ['click the sign in button', 'click on images'], { target: { type: 'string' } }, ['target'], clickText, a => IRREVERSIBLE.test(a.target || '') ? 'change' : 'harmless'),
  tool('browser_type', 'Type on page', 'Type text into a field on the web page that a description names, and check the field shows it.', ['type my email into the email field'], { field: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['field', 'text'], typeText, a => /password|passcode|card|cvv|cvc|iban|ssn|social security/i.test(a.field || '') || (a.submit && IRREVERSIBLE.test(a.field || '')) ? 'change' : 'harmless')
];
