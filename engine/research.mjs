import { search, searchFresh, newsSearch } from './search.mjs';
import { read } from './reader.mjs';
import * as reflex from './reflex.mjs';
import { trust, observe } from './trust.mjs';
import { keywords, words, withTimeout, siteOf, hostOf, clean } from './util.mjs';

function bm25(query, docs) {
  const terms = [...new Set(keywords(query))];
  const tokenized = docs.map(d => words(d));
  const avg = tokenized.reduce((a, t) => a + t.length, 0) / (tokenized.length || 1);
  const df = Object.fromEntries(terms.map(t => [t, tokenized.filter(tokens => tokens.includes(t)).length]));
  return tokenized.map(tokens => {
    let score = 0;
    for (const term of terms) {
      const tf = tokens.filter(x => x === term).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - df[term] + 0.5) / (df[term] + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * tokens.length / avg));
    }
    return score;
  });
}

const jaccard = (a, b) => {
  const A = new Set(words(a)), B = new Set(words(b));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter || 1);
};

const NUMBER_WORDS = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, bn: 1e9 };
const UNITS = [
  [/^(?:km|kilomet(?:er|re)s?)$/i, 'length', 1000], [/^(?:m|met(?:er|re)s?)$/i, 'length', 1], [/^(?:cm|centimet(?:er|re)s?)$/i, 'length', 0.01],
  [/^(?:mm|millimet(?:er|re)s?)$/i, 'length', 0.001], [/^(?:ft|feet|foot)$/i, 'length', 0.3048], [/^(?:in|inch(?:es)?)$/i, 'length', 0.0254],
  [/^(?:mi|miles?)$/i, 'length', 1609.344], [/^(?:kg|kilo(?:gram)?s?)$/i, 'mass', 1], [/^(?:g|grams?)$/i, 'mass', 0.001],
  [/^(?:lbs?|pounds?)$/i, 'mass', 0.4536], [/^(?:t|tonnes?|metric tons?)$/i, 'mass', 1000], [/^(?:°?c|celsius)$/i, 'tempC', 1],
  [/^(?:years?|yrs?)$/i, 'years', 1], [/^(?:km2|km²|square kilomet(?:er|re)s?)$/i, 'area', 1], [/^(?:sq mi|square miles?|mi2|mi²)$/i, 'area', 2.58999]
];
export function parseQuantity(text) {
  const match = String(text).replace(/,(?=\d{3})/g, '').match(/(-?\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion|bn|k\b|m\b)?\s*([a-zA-Z°²]+(?:\s(?:miles?|kilomet(?:er|re)s?|tons?))?)?/i);
  if (!match) return null;
  let value = parseFloat(match[1]);
  let scale = match[2] && !(match[2].toLowerCase() === 'm' && !match[3]) ? NUMBER_WORDS[match[2].toLowerCase()] : 1;
  let unit = match[3] || (match[2]?.toLowerCase() === 'm' ? 'm' : '');
  if (match[2]?.toLowerCase() === 'm' && !match[3]) { scale = 1; unit = 'm'; }
  value *= scale || 1;
  for (const [pattern, dimension, factor] of UNITS) if (pattern.test(unit.trim())) return { value: value * factor, dimension };
  return { value, dimension: 'count' };
}

export function expectedType(question) {
  const q = question.toLowerCase().replace(/^(who|what|which)['’]?s\b/, '$1 is');
  if (/^(what|which) (is|was|are|were) the (capital|name|currency|official language|national language|largest city|biggest city|ceo|president|leader|author|director|founder|owner|mascot|nickname|anthem|motto|chairman|head coach)\b/.test(q.trim())) return 'entity';
  if (/^(who|whom|whose)\b/.test(q.trim())) return 'entity';
  if (/^(when|what year|what date|in what year|which year)\b/.test(q.trim())) return 'date';
  if (/\b(how (many|much|tall|high|long|far|old|big|large|deep|heavy|fast|wide)|population|height|distance|weight|age of|net worth|cost|price|salary|percentage|what percent|temperature|gdp|area|speed|capacity|number of)\b/.test(q)) return 'number';
  if (/^(when|what year|what date|in what year|which year)\b|\b(when (was|did|is|were|does)|what year|founded|born|released|established)\b/.test(q)) return 'date';
  if (/^(who|whom)\b|\bwho (is|was|won|wrote|invented|founded|discovered|created|directed|owns|leads|runs)\b/.test(q)) return 'entity';
  return 'any';
}
const fitsType = (answer, type) => type === 'number' || type === 'date' ? /\d/.test(answer) : type === 'entity' ? /\p{Lu}/u.test(answer) && !/^\d[\d\s,.]*$/.test(answer) : true;

function answerKey(answer) {
  const text = answer.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[“”"'.,;:()]/g, '').trim();
  return text;
}

function sameAnswer(a, b) {
  if (a.key === b.key) return true;
  const yearA = /^\d{4}$/.test(a.key), yearB = /^\d{4}$/.test(b.key);
  const qa = !yearA && parseQuantity(a.answer), qb = !yearB && parseQuantity(b.answer);
  if (qa && qb) {
    if (qa.dimension !== qb.dimension) return false;
    return Math.abs(qa.value - qb.value) / Math.max(Math.abs(qa.value), Math.abs(qb.value), 1e-9) < 0.035;
  }
  if (/\d/.test(a.key) || /\d/.test(b.key)) {
    const da = a.key.match(/\d{4}/)?.[0], db = b.key.match(/\d{4}/)?.[0];
    return Boolean(da && da === db && (a.key.includes(b.key) || b.key.includes(a.key)));
  }
  const wa = new Set(a.key.split(' ')), wb = new Set(b.key.split(' '));
  const smaller = wa.size <= wb.size ? wa : wb, larger = smaller === wa ? wb : wa;
  return smaller.size > 0 && [...smaller].every(w => larger.has(w));
}

const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function dateOf(text) {
  const t = String(text).toLowerCase();
  const md = t.match(new RegExp(MONTH.source + String.raw`\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`));
  const dm = t.match(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?` + MONTH.source + String.raw`(?:,?\s+(\d{4}))?`));
  const year = t.match(/\b(1[5-9]|20)\d\d\b/)?.[0];
  let month, day, y;
  if (md) [month, day, y] = [MONTHS.indexOf(md[1]), +md[2], md[3]];
  else if (dm) [day, month, y] = [+dm[1], MONTHS.indexOf(dm[2]), dm[3]];
  else return year ? { date: new Date(+year, 0, 1), precision: 'year' } : null;
  if (day < 1 || day > 31) return null;
  return { date: new Date(y ? +y : year ? +year : new Date().getFullYear(), month, day), precision: 'day' };
}
export const timeOf = question => /\b(next|upcoming|coming|future)\b/i.test(question) ? 'next' : /\b(last|latest|most recent|previous|recent)\b/i.test(question) ? 'last' : null;

export async function vote(question, passages, { when = null } = {}) {
  const type = expectedType(question);
  const k = type === 'entity' ? 2 : 1;
  const spans = await reflex.extract(question, passages.map(p => p.text), { k });
  let candidates = spans.flatMap((found, i) => (k > 1 ? found : [found]).map((span, rank) => ({
    answer: span.answer.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%)]+$/gu, ''),
    key: answerKey(span.answer),
    weight: span.score * (rank ? 0.5 : 1) * (0.35 + passages[i].relevance) * passages[i].trust,
    reader: span.score,
    passage: passages[i]
  }))).filter(c => c.answer && c.answer.length < 90 && c.reader > 0.08 && fitsType(c.answer, type));
  if (when && type === 'date') {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const c of candidates) {
      const d = dateOf(c.answer);
      if (!d) continue;
      const ahead = d.precision === 'year' ? d.date.getFullYear() >= today.getFullYear() : d.date >= today;
      const behind = d.precision === 'year' ? d.date.getFullYear() <= today.getFullYear() : d.date <= today;
      if ((when === 'next' && !ahead) || (when === 'last' && !behind)) c.weight = 0;
      else c.weight *= 1 + 1 / (1 + Math.abs(d.date - today) / 864e5 / 30);
    }
    candidates = candidates.filter(c => c.weight > 0);
  }

  const clusters = [];
  for (const candidate of candidates.sort((a, b) => b.weight - a.weight)) {
    const home = clusters.find(c => sameAnswer(c.members[0], candidate));
    if (home) home.members.push(candidate); else clusters.push({ members: [candidate] });
  }
  for (const cluster of clusters) {
    const bySite = new Map();
    for (const member of cluster.members) {
      const site = member.passage.site;
      bySite.set(site, Math.max(bySite.get(site) || 0, member.weight));
    }
    cluster.weight = [...bySite.values()].reduce((a, b) => a + b, 0);
    cluster.sites = [...bySite.keys()];
    cluster.answer = cluster.members.slice().sort((a, b) => b.weight - a.weight)[0].answer;
  }
  clusters.sort((a, b) => b.weight - a.weight);
  const total = clusters.reduce((a, c) => a + c.weight, 0) || 1;
  const allSites = new Set(candidates.map(c => c.passage.site));
  let winners = clusters.slice(0, 1);
  const plural = /\b(found(ed|ers?)|co-?found\w*|created|invented|members?|cast|starred|who are|wrote|authors?|discovered|developed|designed|owners?|parents|children|siblings)\b/i.test(question);
  if ((type === 'entity' || type === 'any') && plural) {
    const strong = clusters.filter(c => c.sites.length >= 2 && c.weight >= 0.3 * clusters[0].weight && !/\d/.test(c.answer));
    if (strong.length > 1) winners = strong.slice(0, 4);
  }
  const combinedSites = new Set(winners.flatMap(c => c.sites));
  const names = winners.map(c => c.answer);
  const confidence = winners.reduce((a, c) => a + c.weight, 0) / total;
  const agree = names.length > 1 ? Math.min(...winners.map(c => c.sites.length)) : (clusters[0]?.sites.length || 0);
  const settled = Boolean(clusters[0]) && ((confidence >= 0.6 && agree >= 2) || (agree >= 3 && clusters[0].weight >= 1.5 * (clusters[1]?.weight || 0)));
  return {
    type,
    answer: names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (clusters[0]?.answer || null),
    confidence,
    agree,
    settled,
    supporters: [...combinedSites],
    of: allSites.size,
    alternatives: clusters.slice(0, 4).map(c => ({ answer: c.answer, share: c.weight / total, sites: c.sites, quote: c.members[0].passage.text, url: c.members[0].passage.url })),
    clusters
  };
}

const SKIP_PAGE = /\.(pdf|docx?|pptx?|xlsx?)(\?|$)|youtube\.com|tiktok\.com|instagram\.com|facebook\.com|\/\/(www\.)?x\.com|twitter\.com|pinterest\.|linkedin\.com\/in\//i;
const independentSites = results => new Set(results.filter(r => !/wikipedia\.org$/.test(siteOf(r.url))).map(r => siteOf(r.url))).size;

export async function research(question, { queries, focus, emit = () => {}, signal, fresh = false, news = false, pages: pageBudget = 8, deadline = 4500, top = 10 } = {}) {
  const t0 = performance.now();
  const ask = focus || question;
  const queryList = [...new Set([ask, question, ...(queries || [])])].slice(0, 3);
  emit('search', { queries: queryList });
  const searcher = news ? newsSearch : fresh ? searchFresh : search;
  const gather = async list => Promise.all(list.map(q => searcher(q).catch(error => ({ results: [], providers: [{ name: 'all', error: error.message }] }))));
  let runs = await gather(queryList);
  const firstPass = runs.flatMap(r => r.results);
  if (independentSites(firstPass) < 4) {
    const terms = keywords(ask).join(' ');
    const broader = [terms, fresh || news ? `${terms} latest` : `${terms} explained`].filter(q => q && !queryList.includes(q));
    runs = runs.concat(await gather(broader.slice(0, 1)));
  }
  const merged = new Map();
  runs.forEach((run, qi) => run.results.forEach(r => {
    const prev = merged.get(r.url);
    const score = r.score * (qi === 0 ? 1 : 0.8);
    if (prev) prev.score += score; else merged.set(r.url, { ...r, score });
  }));
  const EN = new Set('the of and to in is for on that with as are was by it at from this be or an which have has not their its can will more about'.split(' '));
  const english = r => { const w = `${r.title} ${r.snippet}`.toLowerCase().match(/\p{L}+/gu) || []; return w.length < 8 || w.filter(x => EN.has(x)).length / w.length >= 0.08; };
  const results = [...merged.values()].filter(english);
  emit('results', { count: results.length, providers: runs.flatMap(r => r.providers || []).reduce((acc, p) => { const a = acc.find(x => x.name === p.name); if (a) a.count += p.count; else acc.push({ ...p }); return acc; }, []) });
  if (!results.length) return { evidence: [], sources: [], vote: null, ms: performance.now() - t0 };

  const snippetScores = await reflex.rerank(ask, results.map(r => `${r.title}. ${r.snippet}`));
  results.forEach((r, i) => { r.site = siteOf(r.url); r.trust = trust(r.site); r.snippetP = snippetScores[i].p; r.pick = r.score * 40 * 2 * r.trust ** 2 * (0.3 + r.snippetP); });
  results.sort((a, b) => b.pick - a.pick);
  const chosen = [], perSite = {};
  for (const r of results) {
    if (SKIP_PAGE.test(r.url) || r.snippetP < 0.05) continue;
    if ((perSite[r.site] = (perSite[r.site] || 0) + 1) > 1) continue;
    chosen.push(r);
    if (chosen.length >= pageBudget) break;
  }
  emit('reading', { sources: chosen.map(r => ({ url: r.url, title: r.title, site: r.site, host: hostOf(r.url), trust: r.trust })) });

  const pages = [];
  let enough;
  const quorum = new Promise(resolve => { enough = resolve; });
  const reading = Promise.all(chosen.map(async r => {
    try {
      const page = await read(r.url, { fresh });
      pages.push({ ...page, result: r });
      emit('read', { url: r.url, passages: page.passages.length, ok: true });
      if (pages.length === Math.min(4, chosen.length)) setTimeout(enough, pages.length === chosen.length ? 0 : 800);
    } catch (error) {
      emit('read', { url: r.url, ok: false, error: error.message });
    }
  }));
  await withTimeout(Promise.race([reading, quorum]), deadline, null);
  if (signal?.aborted) throw new Error('stopped');

  const arrived = pages.slice();
  let passages = [];
  for (const page of arrived) {
    page.passages.forEach((p, index) => passages.push({ ...p, title: page.title, lead: index < 2, trust: trust(page.site), date: page.date || page.result.date }));
  }
  for (const r of results.slice(0, 20)) {
    if (r.snippet && r.snippet.length > 50 && r.snippetP > 0.1) passages.push({ text: clean(r.snippet), url: r.url, title: r.title, site: r.site, host: hostOf(r.url), section: 'Search snippet', trust: r.trust, snippet: true, date: r.date });
  }
  const totalPassages = passages.length;

  const lexical = bm25(ask, passages.map(p => `${p.title} ${p.section} ${p.text}`));
  passages.forEach((p, i) => { p.lexical = lexical[i] + (p.lead ? 2 : 0); });
  passages = passages.sort((a, b) => b.lexical - a.lexical).slice(0, 90);

  const scored = await reflex.rerank(ask, passages.map(p => (p.section && p.section !== 'Overview' && p.section !== 'Search snippet' ? `${p.section}: ` : '') + p.text));
  const year = new Date().getFullYear();
  const recency = p => {
    if (!fresh && !news) return 0;
    const dated = p.date ? new Date(p.date) : null;
    if (dated && !isNaN(dated) && Date.now() - dated < 365 * 86400000) return 1;
    const years = (p.text.match(/\b(19|20)\d\d\b/g) || []).map(Number);
    if (years.length && Math.max(...years) < year - 1) return -1.5;
    return years.includes(year) ? 0.8 : 0;
  };
  passages.forEach((p, i) => { p.relevance = scored[i].p; p.logit = scored[i].logit; p.rank = scored[i].logit + Math.log(p.trust / (1 - p.trust)) * 0.6 + recency(p); });
  passages.sort((a, b) => b.rank - a.rank);

  const evidence = [], fromSite = {};
  for (const p of passages) {
    if (p.relevance < 0.08 && evidence.length >= 4) break;
    if (evidence.some(e => jaccard(e.text, p.text) > 0.6)) continue;
    if ((fromSite[p.site] || 0) >= 3) continue;
    fromSite[p.site] = (fromSite[p.site] || 0) + 1;
    evidence.push(p);
    if (evidence.length >= top) break;
  }
  evidence.forEach((e, i) => { e.id = i + 1; });
  emit('ranked', { passages: totalPassages, kept: evidence.length, top: evidence.slice(0, 3).map(e => ({ site: e.site, relevance: e.relevance })) });

  const sources = [];
  for (const e of evidence) if (!sources.some(s => s.url === e.url)) sources.push({ url: e.url, title: e.title, site: e.site, host: e.host, trust: e.trust, date: e.date || null });
  const snippets = arrived.flatMap(page => (page.snippets || []).map(s => ({ ...s, url: page.url, title: page.title, site: page.site, host: page.host, trust: trust(page.site) })));
  return { evidence, sources, pages: arrived.length, results: results.length, ms: performance.now() - t0, ranked: passages, snippets };
}

export function learnFromVote(result) {
  if (!result?.settled || !result.clusters) return;
  const [winner, ...losers] = result.clusters;
  for (const site of winner.sites) observe(site, true);
  for (const loser of losers) if (loser.weight / (winner.weight || 1) < 0.35) for (const site of loser.sites) if (!winner.sites.includes(site)) observe(site, false);
}

export const POLAR = /^(is|are|was|were|do|does|did|can|could|has|have|had|will|would)\s+(?!i\b|we\b)(?!(?:you|u)\s+(?:please\s+)?(?:explain|tell|show|help|give|write|summari[sz]e|make|find|list|describe|recommend|suggest|translate|check|look|do|create|draw|teach|walk|send|book|open|search|compare)\b)/i;
const HISTORIC = /\b(until|formerly|used to|previously|no longer|once (was|were|considered)|was (once|originally)|reclassif\w+|demoted|downgraded|stripped of)\b/i;
const NEUTRAL_BEFORE = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been', 'its', 'their', 'his', 'her', 'not', 'as', 'in', 'on', 'to', 'for', 'also', 'still', 'true', 'real', 'full', 'actual', 'major', 'that', 'this', 'one', 'only', 'considered', 'called', 'classified']);
function qualifierIn(statement, sentence) {
  const m = statement.match(/\b(?:is|are|was|were)\s+(?:not\s+)?(?:a|an)\s+([\w -]+?)[.!?]?$/i);
  if (!m) return null;
  const head = m[1].trim().split(/\s+/).pop().toLowerCase().replace(/e?s$/, '');
  const own = new Set(words(statement));
  const tokens = sentence.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) || [];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].replace(/e?s$/, '') !== head) continue;
    const before = tokens[i - 1];
    if (!NEUTRAL_BEFORE.has(before) && !own.has(before)) return `${before} ${tokens[i]}`;
  }
  return null;
}
export async function polarVote(statement, index) {
  const [v] = await reflex.embed([statement]);
  const bySite = new Map();
  for (const { u, sim } of index.units.map(u => ({ u, sim: reflex.cosine(v, u.vector) })).sort((a, b) => b.sim - a.sim)) {
    if (sim < 0.5) break;
    const e = index.evidence.find(x => x.id === u.id);
    const site = e?.site || e?.host;
    if (!site) continue;
    const entry = bySite.get(site) || { e, texts: [] };
    if (entry.texts.length < 3) entry.texts.push(u.text);
    bySite.set(site, entry);
    if (bySite.size >= 7 && [...bySite.values()].every(s => s.texts.length >= 3)) break;
  }
  const pairs = [...bySite.entries()].flatMap(([site, s]) => s.texts.map(text => ({ site, text, trust: s.e?.trust ?? 0.6 })));
  if (!pairs.length) return null;
  const results = await reflex.nli(pairs.map(p => p.text), pairs.map(() => statement));
  const sites = new Map();
  pairs.forEach((p, i) => {
    const r = results[i];
    const s = sites.get(p.site) || { yes: null, no: null, qualified: null, trust: p.trust };
    if (r.contradict >= 0.7 && !s.no) s.no = p.text;
    else if (r.entail >= 0.6) {
      const word = qualifierIn(statement, p.text);
      if (word || HISTORIC.test(p.text)) s.qualified ||= { text: p.text, word };
      else if (r.entail >= 0.75) s.yes ||= p.text;
    }
    sites.set(p.site, s);
  });
  const yes = [], no = [], qualified = [];
  for (const [site, s] of sites) {
    if (s.yes && s.no) continue;
    if (s.no) no.push({ site, text: s.no });
    else if (s.qualified) qualified.push({ site, ...s.qualified });
    else if (s.yes) yes.push({ site, text: s.yes });
  }
  let verdict = null;
  if (yes.length >= 2 && yes.length > no.length + qualified.length) verdict = 'yes';
  else if (no.length && no.length >= yes.length) verdict = 'no';
  else if (qualified.length && qualified.length >= yes.length) verdict = 'qualified';
  else if (yes.length && no.length) verdict = 'mixed';
  else if (yes.length === 1) verdict = 'single';
  return { statement, verdict, yes, no, qualified, of: sites.size };
}
