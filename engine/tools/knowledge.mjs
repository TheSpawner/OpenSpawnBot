import dns from 'node:dns/promises';
import { getJSON, getText, cached, HOUR, DAY, MINUTE, clean, keywords } from '../util.mjs';
import { read } from '../reader.mjs';
import { googleNews } from '../search.mjs';
import * as reflex from '../reflex.mjs';

const WD_HEADERS = { 'user-agent': 'ZeroKnowledge/0.1 (local research assistant)' };

const PROPS = {
  P1082: 'population', P2046: 'area', P2048: 'height', P2044: 'elevation above sea level', P2043: 'length', P2049: 'width', P2067: 'mass weight',
  P569: 'date of birth born birthday age how old', P570: 'date of death died', P19: 'place of birth born where', P20: 'place of death', P26: 'spouse wife husband married',
  P36: 'capital city', P35: 'head of state president monarch king queen', P6: 'head of government prime minister mayor leader', P38: 'currency money',
  P37: 'official language spoken', P17: 'country', P131: 'located in region state province', P30: 'continent', P571: 'founded inception established created year',
  P112: 'founded by founder', P169: 'chief executive officer CEO', P159: 'headquarters location', P1128: 'number of employees staff', P2139: 'revenue income',
  P170: 'creator made by', P50: 'author writer wrote', P57: 'film director directed', P86: 'composer', P175: 'performer singer band', P577: 'publication release date released',
  P176: 'manufacturer made by', P178: 'developer developed by', P287: 'designed by designer architect', P84: 'architect', P2047: 'duration runtime length',
  P106: 'occupation job profession', P39: 'position held office', P102: 'political party', P27: 'country of citizenship nationality', P69: 'educated at university school',
  P166: 'award received prize won', P1346: 'winner', P2128: 'speed', P2386: 'diameter', P2067_: '', P1120: 'number of deaths killed', P1339: 'number of injured',
  P580: 'start time began', P582: 'end time ended', P4010: 'GDP gross domestic product economy', P2131: 'nominal GDP', P2250: 'life expectancy', P1081: 'human development index',
  P856: 'official website', P348: 'software version latest version', P277: 'programming language written in', P54: 'member of sports team plays for club',
  P1532: 'country for sport', P286: 'head coach manager', P115: 'home venue stadium', P2257: 'orbital period year length', P2583: 'distance from Earth',
  P1086: 'atomic number', P2101: 'melting point', P2102: 'boiling point', P274: 'chemical formula', P2054: 'density', P2052: 'speed'
};
const PROP_IDS = Object.keys(PROPS).filter(p => PROPS[p]);
let propVectors = null;

const wdSearch = cached('wd-search', 7 * DAY, q => getJSON(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json&limit=5&type=item`, { headers: WD_HEADERS }));
const wdEntities = cached('wd-ent', DAY, ids => getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=claims|labels|descriptions|sitelinks&languages=en&sitefilter=enwiki&format=json`, { headers: WD_HEADERS, timeout: 9000 }));
const wpSearch = cached('wp-ent', 7 * DAY, q => getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=2&srprop=&format=json`, { headers: WD_HEADERS, timeout: 6000 }));
const wpItems = cached('wp-items', 7 * DAY, titles => getJSON(`https://en.wikipedia.org/w/api.php?action=query&prop=pageprops|description&ppprop=wikibase_item&redirects=1&titles=${encodeURIComponent(titles)}&format=json`, { headers: WD_HEADERS, timeout: 6000 }));
async function wikipediaEntities(phrase) {
  const titles = ((await wpSearch(phrase)).query?.search || []).map(s => s.title);
  if (!titles.length) return [];
  const pages = Object.values((await wpItems(titles.join('|'))).query?.pages || {});
  return titles.map(t => pages.find(p => p.title === t)).filter(p => p?.pageprops?.wikibase_item).map(p => ({ id: p.pageprops.wikibase_item, label: p.title, description: p.description || '' }));
}
const wdSitelinks = cached('wd-links', 7 * DAY, ids => getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=sitelinks&format=json`, { headers: WD_HEADERS, timeout: 8000 }));
const wdLabels = cached('wd-lbl', 7 * DAY, ids => getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=labels&languages=en&format=json`, { headers: WD_HEADERS }));
const UNIT_LABELS = { Q11573: 'm', Q828224: 'km', Q712226: 'km²', Q3710: 'ft', Q11570: 'kg', Q25343: 'm²', Q174728: 'cm', Q4917: 'USD', Q4916: 'EUR', Q25250: 'V', Q11579: 'K', Q25267: '°C', Q42289: '°F', Q7727: 'minutes', Q11574: 'seconds', Q573: 'days', Q577: 'years', Q1811: 'AU', Q531: 'light-years', Q182429: 'm/s', Q180154: 'km/h', Q13147228: 'g/cm³' };

function entityCandidates(question) {
  const q = question.replace(/[?!.]+$/, '');
  const out = [];
  const ofMatch = q.match(/\b(?:of|for|about|does|did|is|was|are)\s+(?:the\s+)?([A-Z\p{Lu}][\p{L}\p{N}'’.\- ]+?)(?:'s|\s+(?:in|on|at|have|has|located|born|die|founded|released)\b|$)/u);
  if (ofMatch) out.push(ofMatch[1].trim());
  for (const m of q.matchAll(/\b([A-Z\p{Lu}][\p{L}\p{N}'’.\-]+(?:\s+(?:of|the|de|van|von|da|and|&)?\s*[A-Z\p{Lu}][\p{L}\p{N}'’.\-]+)*)/gu)) {
    const phrase = m[1].replace(/^(What|Who|When|Where|How|Which|Is|Was|Did|Does|The|In|Tell|Give)\s+/, '').trim();
    if (phrase.length > 1 && !/^(What|Who|When|Where|How|Which|Is|Was|Did|Does|The|I|In|Tell|Give)$/.test(phrase)) out.push(phrase);
  }
  const possessive = q.match(/([\p{L}\p{N} ]+?)'s\s/u);
  if (possessive) out.push(possessive[1].trim().split(' ').slice(-3).join(' '));
  return [...new Set(out)].slice(0, 3);
}

function valueOf(snak) {
  const v = snak?.datavalue?.value;
  if (v == null) return null;
  switch (snak.datavalue.type) {
    case 'wikibase-entityid': return { entity: v.id };
    case 'time': {
      const precision = v.precision; const m = v.time.match(/^([+-])(\d+)-(\d\d)-(\d\d)/);
      if (!m) return { text: v.time };
      const [, sign, y, mo, d] = m; const year = Number(y) * (sign === '-' ? -1 : 1);
      if (precision >= 11) return { text: new Date(Date.UTC(year, mo - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }), year };
      if (precision === 10) return { text: new Date(Date.UTC(year, mo - 1, 1)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }), year };
      return { text: year < 0 ? `${-year} BC` : String(year), year };
    }
    case 'quantity': {
      const amount = Number(v.amount); const unit = v.unit?.split('/').pop();
      return { text: `${amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}${UNIT_LABELS[unit] ? ' ' + UNIT_LABELS[unit] : ''}`, amount };
    }
    case 'monolingualtext': return { text: v.text };
    case 'string': return { text: v };
    case 'globecoordinate': return { text: `${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)}` };
    default: return null;
  }
}
const qualifierYear = claim => { const q = claim.qualifiers?.P585?.[0] || claim.qualifiers?.P580?.[0]; const v = q && valueOf(q); return v?.year ?? null; };

async function wikidataFacts(question, { maxProps = 3 } = {}) {
  const candidates = entityCandidates(question);
  if (!candidates.length) return null;
  const [searches, viaWikipedia] = await Promise.all([
    Promise.all(candidates.map(c => wdSearch(c).catch(() => ({ search: [] })))),
    Promise.all(candidates.map(c => wikipediaEntities(c).catch(() => [])))
  ]);
  const seen = new Set();
  const hits = [
    ...viaWikipedia.flatMap((list, i) => list.map((h, rank) => ({ ...h, from: candidates[i], rank: rank * 0.5 }))),
    ...searches.flatMap((s, i) => (s.search || []).slice(0, 2).map((h, rank) => ({ ...h, from: candidates[i], rank })))
  ].filter(h => h.id && !seen.has(h.id) && seen.add(h.id));
  if (!hits.length) return null;
  const [relevance, links] = await Promise.all([
    reflex.rerank(question, hits.map(h => `${h.label}: ${h.description || ''}`)),
    wdSitelinks([...new Set(hits.map(h => h.id))].join('|')).catch(() => null)
  ]);
  const aboutLife = /\b(born|birth|birthday|died|death|age|old|married|wife|husband|spouse|children|kids|parents|father|mother|grew up|educated|height of|net worth)\b/i.test(question);
  const personLike = d => /\b(politician|president|prime minister|actor|actress|singer|musician|rapper|writer|author|novelist|poet|player|footballer|athlete|scientist|physicist|chemist|mathematician|businessman|businesswoman|entrepreneur|investor|artist|painter|composer|director|journalist|economist|philosopher|engineer|lawyer|judge|king|queen|prince|princess|emperor|monarch|astronaut|inventor|chef|model|comedian|youtuber)\b|\(\d{3,4}\s*[–-]/i.test(d || '');
  hits.forEach((h, i) => {
    const editions = Object.keys(links?.entities?.[h.id]?.sitelinks || {}).length;
    const exact = h.label.toLowerCase() === h.from.toLowerCase() ? (h.from.includes(' ') ? 2 : 0.5) : 0;
    h.score = relevance[i].logit - h.rank * 1.5 + exact + Math.log1p(editions) / 1.5 + (aboutLife && personLike(h.description) ? 2 : 0);
  });
  const entity = hits.sort((a, b) => b.score - a.score)[0];
  if (process.env.ZK_DEBUG_WD) console.error('[wikidata]', question, hits.map(h => `${h.id} ${h.label} (${h.description?.slice(0, 40)}) ${h.score.toFixed(2)}`));
  const data = await wdEntities(entity.id);
  const item = data.entities?.[entity.id];
  if (!item) return null;
  const present = PROP_IDS.filter(p => item.claims?.[p]?.length);
  if (!present.length) return null;
  propVectors ||= Object.fromEntries(PROP_IDS.map((p, i) => [p, null]));
  const missing = present.filter(p => !propVectors[p]);
  if (missing.length) (await reflex.embed(missing.map(p => PROPS[p]))).forEach((v, i) => { propVectors[missing[i]] = v; });
  const subject = question.replace(new RegExp(entity.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim();
  const [qv] = await reflex.embed([subject || question]);
  const ranked = present.map(p => ({ p, sim: reflex.cosine(qv, propVectors[p]) })).sort((a, b) => b.sim - a.sim);
  const chosen = ranked.filter((r, i) => i < maxProps && r.sim > 0.6);
  if (!chosen.length) return null;

  const facts = [], rows = [];
  const needLabels = new Set();
  const picked = chosen.map(({ p }) => {
    let claims = item.claims[p].filter(c => c.rank !== 'deprecated' && c.mainsnak.snaktype === 'value');
    const preferred = claims.filter(c => c.rank === 'preferred');
    if (preferred.length) claims = preferred;
    claims = claims.slice().sort((a, b) => (qualifierYear(b) ?? 0) - (qualifierYear(a) ?? 0)).slice(0, p === 'P1082' || p === 'P2046' || p === 'P1128' || p === 'P2139' || p === 'P4010' ? 1 : 4);
    const values = claims.map(c => ({ v: valueOf(c.mainsnak), year: qualifierYear(c), ended: Boolean(c.qualifiers?.P582) })).filter(x => x.v);
    values.forEach(x => x.v.entity && needLabels.add(x.v.entity));
    return { p, values };
  });
  if (needLabels.size) {
    const labels = await wdLabels([...needLabels].slice(0, 45).join('|')).catch(() => ({ entities: {} }));
    for (const pick of picked) for (const x of pick.values) if (x.v.entity) x.v.text = labels.entities?.[x.v.entity]?.labels?.en?.value || x.v.entity;
  }
  const name = item.labels?.en?.value || entity.label;
  for (const { p, values } of picked) {
    const current = values.filter(x => !x.ended);
    const shown = (current.length ? current : values).filter(x => x.v.text);
    if (!shown.length) continue;
    const label = PROPS[p].split(' ').slice(0, p === 'P569' ? 3 : 4).join(' ').replace(/ born birthday age how old| died| born where/, '');
    const text = shown.map(x => x.v.text + (x.year ? ` (as of ${x.year})` : '')).join(', ');
    let fact = `${name} — ${label}: ${text}.`;
    if (p === 'P569' && shown[0].v.year && !item.claims.P570) {
      const birth = item.claims.P569[0].mainsnak.datavalue.value.time.match(/(\d+)-(\d\d)-(\d\d)/);
      const now = new Date(); let age = now.getFullYear() - Number(birth[1]);
      if (now.getMonth() + 1 < Number(birth[2]) || (now.getMonth() + 1 === Number(birth[2]) && now.getDate() < Number(birth[3]))) age--;
      fact += ` ${name} is ${age} years old.`;
    }
    facts.push(fact);
    rows.push({ label, value: text });
  }
  if (!facts.length) return null;
  const description = item.descriptions?.en?.value;
  return {
    facts: description ? [`${name} is ${/^(a|an|the)\s/i.test(description) ? description : `a ${description}`}.`, ...facts] : facts,
    card: { kind: 'facts', title: name, subtitle: description, rows, url: `https://www.wikidata.org/wiki/${entity.id}` },
    sources: [{ title: `Wikidata: ${name} (${entity.id})`, url: `https://www.wikidata.org/wiki/${entity.id}` }],
    trust: 0.92
  };
}

const wikidata = {
  id: 'wikidata', title: 'Wikidata facts', family: 'Knowledge', standalone: false, booster: true,
  description: 'Exact structured facts about people, places, organisations and things: population, dates, heights, leaders, founders',
  examples: ['population of Tokyo', 'when was Barack Obama born', 'how tall is Mount Everest', 'who is the CEO of Microsoft', 'capital of Australia', 'who founded Nvidia', 'how old is Taylor Swift', 'area of Brazil', 'who directed Inception', 'currency of Japan'],
  extract: q => ({ question: q }),
  run: async ({ question }) => {
    const result = await wikidataFacts(question);
    if (!result) throw new Error('no matching structured fact');
    return result;
  }
};

const define = {
  id: 'dictionary', title: 'Dictionary', family: 'Language', standalone: true,
  description: 'Definitions, part of speech and usage of an English word (Wiktionary)',
  examples: ['define serendipity', 'what does ephemeral mean', 'meaning of the word ubiquitous', 'definition of irony', 'what is the meaning of "laconic"', 'dictionary: petrichor'],
  pattern: /^(define|definition of|meaning of)\b|\bwhat does (the word )?["“']?[\w-]+["”']? mean\b|\bmeaning of the word\b/i,
  args: { word: { type: 'string' } },
  extract: q => { const m = q.match(/(?:define|definition of|meaning of(?: the word)?|what does(?: the word)?|dictionary:?)\s+["“']?([\p{L}\- ]+?)["”']?(?:\s+mean)?\??$/iu); return m ? { word: m[1].trim().toLowerCase() } : null; },
  async run({ word }) {
    const data = await getJSON(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word.replace(/ /g, '_'))}`);
    const entries = (data.en || []).slice(0, 3);
    if (!entries.length) throw new Error(`no definition for ${word}`);
    const strip = h => clean(String(h).replace(/<[^>]+>/g, ''));
    const senses = entries.flatMap(e => e.definitions.filter(d => strip(d.definition)).slice(0, 3).map(d => ({ pos: e.partOfSpeech, text: strip(d.definition), example: d.examples?.[0] ? strip(d.examples[0]) : null })));
    return {
      facts: senses.map(s => `${word} (${s.pos.toLowerCase()}): ${s.text}${s.example ? ` Example: "${s.example}"` : ''}`),
      card: { kind: 'definition', word, senses },
      sources: [{ title: `Wiktionary: ${word}`, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}` }]
    };
  }
};

const thesaurus = {
  id: 'thesaurus', title: 'Thesaurus & rhymes', family: 'Language', standalone: true,
  description: 'Synonyms, antonyms, rhymes and related words',
  examples: ['synonyms for happy', 'another word for big', 'words that rhyme with orange', 'antonym of generous', 'what rhymes with love', 'a fancier word for good'],
  pattern: /\b(synonyms?|antonyms?|opposite of|another word for|other words for|rhymes? with|words that rhyme|fancier word|similar words? (to|for))\b/i,
  args: { word: { type: 'string' }, relation: { enum: ['syn', 'ant', 'rhy'] } },
  extract: q => { const m = q.match(/(?:synonyms? (?:for|of)|antonyms? (?:for|of)|opposite of|another word for|other words for|rhymes? with|rhyme with|word for|similar words? (?:to|for))\s+["“']?([\p{L}\- ]+?)["”']?\??$/iu); return m ? { word: m[1].trim(), relation: /antonym|opposite/i.test(q) ? 'ant' : /rhym/i.test(q) ? 'rhy' : 'syn' } : null; },
  async run({ word, relation = 'syn' }) {
    const list = await getJSON(`https://api.datamuse.com/words?rel_${relation}=${encodeURIComponent(word)}&max=24`);
    const extra = relation === 'syn' && list.length < 8 ? await getJSON(`https://api.datamuse.com/words?ml=${encodeURIComponent(word)}&max=16`) : [];
    const words = [...new Set([...list, ...extra].map(w => w.word))].slice(0, 20);
    const label = { syn: 'Synonyms', ant: 'Antonyms', rhy: 'Rhymes' }[relation];
    return { facts: [`${label} for "${word}": ${words.join(', ')}.`], card: { kind: 'chips', title: `${label} for “${word}”`, items: words }, sources: [{ title: 'Datamuse', url: 'https://www.datamuse.com/api/' }] };
  }
};

const headlines = {
  id: 'headlines', title: 'News headlines', family: 'Feeds', standalone: false,
  description: 'Latest news headlines, overall or on a topic',
  examples: ['what is in the news today', 'latest news about AI', 'top headlines', 'news on the election', 'what happened today in the world', 'recent news about Tesla', 'breaking news'],
  pattern: /\b(news|headlines?|breaking|what happened today|current events)\b/i,
  extract: q => ({ topic: q.replace(/\b(what('s| is)|latest|recent|top|breaking|today'?s?|the|in|news|headlines?|about|on|any|current events|give me|show me|happened|world)\b/gi, ' ').replace(/[?]/g, '').replace(/\s+/g, ' ').trim() }),
  async run({ topic }) {
    const items = topic ? await googleNews(topic) : await (async () => {
      const xml = await getText('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en');
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map(([, b]) => ({ title: (b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), url: (b.match(/<link>([\s\S]*?)<\/link>/) || [])[1], date: (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1], publisher: (b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] }));
    })();
    const top = items.filter(i => i.title).slice(0, 10);
    return {
      facts: top.map(i => `${new Date(i.date).toUTCString().slice(5, 16)} — ${i.title}`),
      card: { kind: 'list', title: topic ? `News: ${topic}` : 'Top headlines', items: top.map(i => ({ label: new Date(i.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), text: i.title.replace(/\s+-\s+[^-]+$/, ''), meta: i.publisher || '', url: i.url })) },
      sources: [{ title: 'Google News', url: `https://news.google.com/search?q=${encodeURIComponent(topic || '')}` }]
    };
  }
};

const hn = {
  id: 'hackernews', title: 'Hacker News', family: 'Feeds', standalone: true,
  description: 'Top stories on Hacker News right now',
  examples: ['top stories on hacker news', 'what is trending on HN', 'hacker news front page', 'what are developers talking about today'],
  pattern: /\b(hacker ?news|\bhn\b|ycombinator)\b/i,
  extract: () => ({}),
  async run() {
    const ids = (await getJSON('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, 10);
    const items = await Promise.all(ids.map(id => getJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));
    return {
      facts: items.map((s, i) => `#${i + 1}: ${s.title} (${s.score} points, ${s.descendants || 0} comments)`),
      card: { kind: 'list', title: 'Hacker News — front page', items: items.map((s, i) => ({ label: `${s.score}`, text: s.title, meta: s.url ? new URL(s.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com', url: s.url || `https://news.ycombinator.com/item?id=${s.id}` })) },
      sources: [{ title: 'Hacker News', url: 'https://news.ycombinator.com' }]
    };
  }
};

const launches = {
  id: 'launches', title: 'Rocket launches', family: 'Feeds', standalone: true,
  description: 'Upcoming rocket and space launches',
  examples: ['next rocket launch', 'upcoming SpaceX launches', 'when is the next launch', 'space launches this week', 'next starship launch'],
  pattern: /\b(rocket|launch(es)?|spacex|starship|falcon 9|blue origin|ula)\b.*\b(next|upcoming|when|schedule|this week)\b|\b(next|upcoming)\b.*\b(launch|launches|rocket)\b/i,
  extract: q => ({ filter: (q.match(/\b(spacex|starship|falcon|blue origin|new glenn|ula|vulcan|rocket lab|electron|ariane|soyuz|isro|nasa|artemis)\b/i) || [])[1] || '' }),
  async run({ filter }) {
    const data = await getJSON(`https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=12${filter ? '&search=' + encodeURIComponent(filter) : ''}`);
    const list = (data.results || []).slice(0, 8);
    return {
      facts: list.map(l => `${l.net?.slice(0, 16).replace('T', ' ')} UTC — ${l.name} by ${l.launch_service_provider?.name} from ${l.pad?.location?.name} (status: ${l.status?.name}).`),
      card: { kind: 'list', title: `Upcoming launches${filter ? ' — ' + filter : ''}`, items: list.map(l => ({ label: new Date(l.net).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), text: l.name, meta: `${l.launch_service_provider?.name} · ${l.status?.abbrev}`, url: l.url })) },
      sources: [{ title: 'The Space Devs — Launch Library 2', url: 'https://thespacedevs.com/llapi' }]
    };
  }
};

const arxiv = {
  id: 'arxiv', title: 'arXiv papers', family: 'Research', standalone: false,
  description: 'Search scientific preprints on arXiv (physics, maths, computer science, AI)',
  examples: ['latest arxiv papers on diffusion models', 'arxiv papers about quantum error correction', 'find research papers on graph neural networks', 'find a preprint on mixture of experts', 'show me recent scientific papers about dark matter'],
  pattern: /\b(arxiv|preprints?|papers? (on|about)|research papers?|scientific papers?|publications? on)\b/i,
  extract: q => ({ query: q.replace(/\b(find|search|show|latest|recent|new|arxiv|papers?|research|on|about|scientific|publications?|me|a|the|for)\b/gi, ' ').replace(/\s+/g, ' ').trim() }),
  async run({ query }) {
    const xml = await getText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&sortBy=relevance&max_results=6`, { timeout: 12000 });
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
      title: clean((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]), summary: clean((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]),
      url: (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1], date: (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1]?.slice(0, 10),
      authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(a => a[1]).slice(0, 3)
    }));
    return {
      facts: entries.map(p => `"${p.title}" by ${p.authors.join(', ')} (${p.date}): ${p.summary.split('. ').slice(0, 2).join('. ')}.`),
      card: { kind: 'list', title: `arXiv: ${query}`, items: entries.map(p => ({ label: p.date?.slice(0, 7), text: p.title, meta: p.authors.join(', '), url: p.url })) },
      sources: entries.slice(0, 4).map(p => ({ title: p.title, url: p.url }))
    };
  }
};

const pubmed = {
  id: 'pubmed', title: 'PubMed', family: 'Research', standalone: false,
  description: 'Search peer-reviewed medical and biomedical literature',
  examples: ['studies on intermittent fasting', 'pubmed research on vitamin D and depression', 'clinical trials of semaglutide', 'medical research about long covid', 'what does research say about creatine'],
  pattern: /\b(pubmed|clinical (trials?|studies)|medical (research|literature|studies)|peer.reviewed|meta.analys[ie]s|studies (on|about|of))\b/i,
  extract: q => ({ query: q.replace(/\b(pubmed|research|studies|study|on|about|what does|say|clinical|medical|literature|find|the|of)\b/gi, ' ').replace(/\s+/g, ' ').trim() }),
  async run({ query }) {
    const ids = (await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=6&sort=relevance`)).esearchresult.idlist;
    if (!ids.length) throw new Error('no studies found');
    const sum = await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`);
    const papers = ids.map(id => sum.result[id]).filter(Boolean);
    return {
      facts: papers.map(p => `"${p.title}" — ${p.fulljournalname}, ${p.pubdate} (${p.authors?.slice(0, 2).map(a => a.name).join(', ')}).`),
      card: { kind: 'list', title: `PubMed: ${query}`, items: papers.map(p => ({ label: p.pubdate?.slice(0, 4), text: p.title, meta: p.source, url: `https://pubmed.ncbi.nlm.nih.gov/${p.uid}/` })) },
      sources: papers.slice(0, 4).map(p => ({ title: p.title, url: `https://pubmed.ncbi.nlm.nih.gov/${p.uid}/` }))
    };
  }
};

const github = {
  id: 'github', title: 'GitHub', family: 'Code', standalone: true,
  description: 'Find GitHub repositories, their stars, language, description and latest activity',
  examples: ['github repo for llama.cpp', 'most popular rust web frameworks on github', 'how many stars does react have', 'find a github project for pdf parsing in python', 'ollama github'],
  pattern: /\bgithub\b|\brepo(sitory)?\b|\bstars does\b/i,
  extract: q => ({ query: q.replace(/\b(github|repo(sitory)?|find|a|the|for|on|project|how many|stars|does|have|most popular|what is)\b/gi, ' ').replace(/[?]/g, '').replace(/\s+/g, ' ').trim() }),
  async run({ query }) {
    const data = await getJSON(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=6`, { headers: { accept: 'application/vnd.github+json' } });
    const repos = data.items || [];
    if (!repos.length) throw new Error('no repositories found');
    return {
      facts: repos.map(r => `${r.full_name}: ${r.description || 'no description'} — ${r.stargazers_count.toLocaleString()} stars, ${r.language || 'mixed'}, last pushed ${r.pushed_at.slice(0, 10)}, licence ${r.license?.spdx_id || 'none'}.`),
      card: { kind: 'list', title: `GitHub: ${query}`, items: repos.map(r => ({ label: `★ ${r.stargazers_count >= 1000 ? (r.stargazers_count / 1000).toFixed(1) + 'k' : r.stargazers_count}`, text: r.full_name, meta: `${r.language || ''} · ${(r.description || '').slice(0, 80)}`, url: r.html_url })) },
      sources: repos.slice(0, 3).map(r => ({ title: r.full_name, url: r.html_url }))
    };
  }
};

const packages = {
  id: 'packages', title: 'Package registry', family: 'Code', standalone: true,
  description: 'Latest version, description and links of an npm or PyPI package',
  examples: ['latest version of react', 'what is the newest version of numpy', 'npm package express', 'pypi requests version', 'current version of pandas', 'is lodash still maintained'],
  pattern: /\b(npm|pypi|pip install|package|latest version|newest version|current version)\b/i,
  extract: q => { const m = q.match(/(?:version of|package|npm|pypi|pip install|of the)\s+([@\w./-]+)/i) || q.match(/([@\w./-]+)\s+(?:package|version|on npm|on pypi)/i); return m ? { name: m[1].toLowerCase(), registry: /pypi|pip|python|numpy|pandas|django|flask|scipy|torch/i.test(q) ? 'pypi' : /npm|node|js\b|react|vue|express/i.test(q) ? 'npm' : 'both' } : null; },
  async run({ name, registry = 'both' }) {
    const tryNpm = async () => { const d = await getJSON(`https://registry.npmjs.org/${name}`); const v = d['dist-tags'].latest; return { registry: 'npm', name, version: v, date: d.time?.[v]?.slice(0, 10), description: d.description, url: `https://www.npmjs.com/package/${name}`, license: d.license }; };
    const tryPypi = async () => { const d = await getJSON(`https://pypi.org/pypi/${name}/json`); const v = d.info.version; return { registry: 'PyPI', name, version: v, date: d.releases?.[v]?.[0]?.upload_time?.slice(0, 10), description: d.info.summary, url: d.info.package_url, license: d.info.license?.slice(0, 40) }; };
    const order = registry === 'pypi' ? [tryPypi, tryNpm] : [tryNpm, tryPypi];
    let pkg = null;
    for (const attempt of order) { pkg = await attempt().catch(() => null); if (pkg) break; }
    if (!pkg) throw new Error(`no package called ${name}`);
    return {
      facts: [`The latest ${pkg.registry} release of ${pkg.name} is ${pkg.version}${pkg.date ? `, published ${pkg.date}` : ''}. ${pkg.description || ''}`],
      card: { kind: 'big', headline: `${pkg.name} ${pkg.version}`, detail: `${pkg.registry} · ${pkg.date || ''} · ${pkg.description || ''}`, mono: true },
      sources: [{ title: `${pkg.registry}: ${pkg.name}`, url: pkg.url }]
    };
  }
};

const books = {
  id: 'books', title: 'Books', family: 'Knowledge', standalone: false,
  description: 'Find books, their authors, first publication year and editions (Open Library)',
  examples: ['who wrote Dune', 'books by Ursula K. Le Guin', 'when was 1984 by George Orwell published', 'find the book Sapiens', 'how many pages is War and Peace'],
  pattern: /\b(book|novel|books by|who wrote|author of|published|pages)\b/i,
  extract: q => ({ query: q.replace(/\b(who wrote|books? by|the book|find|when was|published|author of|how many pages is|novel)\b/gi, ' ').replace(/[?]/g, '').replace(/\s+/g, ' ').trim() }),
  async run({ query }) {
    const data = await getJSON(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5&fields=key,title,author_name,first_publish_year,number_of_pages_median,edition_count`);
    const docs = data.docs || [];
    if (!docs.length) throw new Error('no books found');
    return {
      facts: docs.map(d => `"${d.title}" by ${(d.author_name || ['unknown']).slice(0, 2).join(', ')}, first published ${d.first_publish_year || 'unknown'}${d.number_of_pages_median ? `, about ${d.number_of_pages_median} pages` : ''}, ${d.edition_count} editions.`),
      card: { kind: 'list', title: `Books: ${query}`, items: docs.map(d => ({ label: String(d.first_publish_year || ''), text: d.title, meta: (d.author_name || []).slice(0, 2).join(', '), url: `https://openlibrary.org${d.key}` })) },
      sources: [{ title: 'Open Library', url: `https://openlibrary.org/search?q=${encodeURIComponent(query)}` }]
    };
  }
};

const INDICATORS = { 'gdp per capita': 'NY.GDP.PCAP.CD', gdp: 'NY.GDP.MKTP.CD', population: 'SP.POP.TOTL', inflation: 'FP.CPI.TOTL.ZG', unemployment: 'SL.UEM.TOTL.ZS', 'life expectancy': 'SP.DYN.LE00.IN', 'gdp growth': 'NY.GDP.MKTP.KD.ZG', 'co2 emissions': 'EN.GHG.CO2.PC.CE.AR5', 'literacy': 'SE.ADT.LITR.ZS', 'fertility rate': 'SP.DYN.TFRT.IN', 'internet users': 'IT.NET.USER.ZS', 'debt': 'GC.DOD.TOTL.GD.ZS' };
const worldbank = {
  id: 'worldbank', title: 'World Bank data', family: 'Knowledge', standalone: false, booster: true,
  description: 'Official country statistics: GDP, GDP per capita, inflation, unemployment, life expectancy, population',
  examples: ['GDP of Nigeria', 'inflation rate in Turkey', 'unemployment in Spain', 'life expectancy in Japan', 'GDP per capita of Norway', 'what is the fertility rate in South Korea'],
  pattern: /\b(gdp|inflation|unemployment|life expectancy|fertility rate|gdp per capita|co2 emissions|literacy rate|internet users|national debt)\b/i,
  extract: q => {
    const t = q.toLowerCase();
    const indicator = Object.keys(INDICATORS).find(k => t.includes(k));
    const country = t.match(/\b(?:of|in|for)\s+(?:the\s+)?([a-z][a-z .'-]+?)(?:\s+(?:in|for|right now|today|currently)\b.*)?\??$/)?.[1];
    return indicator && country ? { indicator, country } : null;
  },
  async run({ indicator, country }) {
    const countries = await cached('wb-countries', 30 * DAY, () => getJSON('https://api.worldbank.org/v2/country?format=json&per_page=400'))();
    const match = countries[1].find(c => c.name.toLowerCase() === country.toLowerCase()) || countries[1].find(c => c.name.toLowerCase().startsWith(country.toLowerCase())) || countries[1].find(c => c.name.toLowerCase().includes(country.toLowerCase()));
    if (!match) throw new Error(`no country ${country}`);
    const data = await getJSON(`https://api.worldbank.org/v2/country/${match.id}/indicator/${INDICATORS[indicator]}?format=json&per_page=6&mrnev=5`);
    const rows = (data[1] || []).filter(r => r.value != null);
    if (!rows.length) throw new Error('no data');
    const fmtV = v => Math.abs(v) >= 1e9 ? `${(v / 1e12 >= 1 ? (v / 1e12).toFixed(2) + ' trillion' : (v / 1e9).toFixed(1) + ' billion')}` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)} million` : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const unit = /ZS|ZG/.test(INDICATORS[indicator]) ? '%' : /CD$/.test(INDICATORS[indicator]) ? ' US$' : '';
    return {
      facts: [`${rows[0].indicator.value} for ${match.name}: ${fmtV(rows[0].value)}${unit} in ${rows[0].date} (World Bank).`, ...rows.slice(1).map(r => `${r.date}: ${fmtV(r.value)}${unit}`)],
      card: { kind: 'facts', title: `${match.name} — ${rows[0].indicator.value}`, rows: rows.map(r => ({ label: r.date, value: fmtV(r.value) + unit })), url: `https://data.worldbank.org/indicator/${INDICATORS[indicator]}?locations=${match.iso2Code}` },
      sources: [{ title: `World Bank: ${rows[0].indicator.value}, ${match.name}`, url: `https://data.worldbank.org/indicator/${INDICATORS[indicator]}?locations=${match.iso2Code}` }],
      trust: 0.93
    };
  }
};

const food = {
  id: 'nutrition', title: 'Nutrition facts', family: 'Knowledge', standalone: false,
  description: 'Calories and nutrition facts of foods and packaged products',
  examples: ['how many calories in a banana', 'nutrition facts for nutella', 'protein in chicken breast', 'calories in a big mac', 'how much sugar is in coca cola'],
  pattern: /\b(calories|kcal|nutrition|protein|carbs|carbohydrates|sugar|fat) (in|of|for)\b|\bnutrition(al)? (facts|info)\b/i,
  extract: q => ({ food: q.replace(/\b(how many|how much|calories|kcal|nutrition(al)?|facts|info|protein|carbs|carbohydrates|sugar|fat|is|are|in|of|for|a|an|the)\b/gi, ' ').replace(/[?]/g, '').replace(/\s+/g, ' ').trim() }),
  async run({ food: name }) {
    const data = await getJSON(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(name)}&json=1&page_size=5&fields=product_name,brands,nutriments,code`, { timeout: 9000 });
    const product = (data.products || []).find(p => p.nutriments?.['energy-kcal_100g'] != null);
    if (!product) throw new Error('no nutrition data');
    const n = product.nutriments;
    const per = k => n[`${k}_100g`] != null ? Math.round(n[`${k}_100g`] * 10) / 10 : null;
    return {
      facts: [`Per 100 g of ${product.product_name}${product.brands ? ` (${product.brands})` : ''}: ${per('energy-kcal')} kcal, ${per('proteins')} g protein, ${per('carbohydrates')} g carbohydrates (${per('sugars')} g sugars), ${per('fat')} g fat, ${per('fiber') ?? '?'} g fibre.`],
      card: { kind: 'facts', title: product.product_name, subtitle: 'per 100 g', rows: [['Energy', `${per('energy-kcal')} kcal`], ['Protein', `${per('proteins')} g`], ['Carbohydrates', `${per('carbohydrates')} g`], ['Sugars', `${per('sugars')} g`], ['Fat', `${per('fat')} g`]].map(([label, value]) => ({ label, value })) },
      sources: [{ title: `Open Food Facts: ${product.product_name}`, url: `https://world.openfoodfacts.org/product/${product.code}` }]
    };
  }
};

const pageReader = {
  id: 'read_url', title: 'Read a web page', family: 'Web', standalone: false,
  description: 'Read and summarise a specific web page or article the user links to',
  examples: ['summarize https://example.com/article', 'what does this page say https://...', 'read this link and tell me the key points', 'tl;dr of https://news.site/story'],
  pattern: /https?:\/\/\S+/i,
  extract: q => { const m = q.match(/https?:\/\/[^\s)>\]]+/i); return m ? { url: m[0] } : null; },
  async run({ url }) {
    const page = await read(url, { fresh: true });
    return { facts: [], passages: page.passages.map(p => ({ ...p, title: page.title, trust: 0.75 })), card: { kind: 'page', title: page.title, url, host: page.host, count: page.passages.length }, sources: [{ title: page.title, url }] };
  }
};

const dnsTool = {
  id: 'dns', title: 'DNS lookup', family: 'Web', standalone: true,
  description: 'Look up the IP addresses, mail servers and DNS records of a domain',
  examples: ['dns records for google.com', 'what is the ip address of github.com', 'mx records of gmail.com', 'lookup example.org', 'nameservers for cloudflare.com'],
  pattern: /\b(dns|ip address of|mx records?|nameservers?|a records?|lookup)\b.*\b[\w-]+\.[a-z]{2,}\b/i,
  extract: q => { const m = q.match(/\b((?:[\w-]+\.)+[a-z]{2,})\b/i); return m ? { domain: m[1].toLowerCase() } : null; },
  async run({ domain }) {
    const [a, aaaa, mx, ns] = await Promise.all([dns.resolve4(domain).catch(() => []), dns.resolve6(domain).catch(() => []), dns.resolveMx(domain).catch(() => []), dns.resolveNs(domain).catch(() => [])]);
    const rows = [['A', a.join(', ')], ['AAAA', aaaa.slice(0, 3).join(', ')], ['MX', mx.sort((x, y) => x.priority - y.priority).map(m => `${m.exchange} (${m.priority})`).slice(0, 4).join(', ')], ['NS', ns.join(', ')]].filter(r => r[1]);
    if (!rows.length) throw new Error(`no DNS records for ${domain}`);
    return { facts: rows.map(([t, v]) => `${domain} ${t} records: ${v}`), card: { kind: 'facts', title: domain, subtitle: 'live DNS', rows: rows.map(([label, value]) => ({ label, value })) }, sources: [{ title: 'Live DNS resolution from this machine', url: '' }] };
  }
};

export default [wikidata, worldbank, define, thesaurus, headlines, hn, launches, arxiv, pubmed, github, packages, books, food, pageReader, dnsTool];
export { wikidataFacts, entityCandidates };
