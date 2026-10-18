import * as reflex from './reflex.mjs';
import { sentences, words } from './util.mjs';
import { parseQuantity } from './research.mjs';

const META = /^(based on|according to the (evidence|sources|information)|the evidence|from the evidence|here('s| is)|in summary|overall,? (the|this)|to summari[sz]e|i hope|let me know|feel free|bottom line:?$)/i;

function numbersIn(text) {
  const found = [];
  const cleanText = String(text).replace(/\[\d+(?:,\s*\d+)*\]/g, '');
  for (const m of cleanText.matchAll(/(?<![\w.])(-?\d[\d,]*(?:\.\d+)?)(\s*(?:%|percent|thousand|million|billion|trillion|bn|km2|km²|km|kilomet(?:er|re)s?|met(?:er|re)s?|m\b|cm|mm|ft|feet|foot|inch(?:es)?|miles?|mi\b|kg|kilograms?|lbs?|pounds?|tonnes?|°?C\b|°?F\b)?)/gi)) {
    const raw = m[0].trim();
    if (/^\d$/.test(raw)) continue;
    found.push(raw);
  }
  return found;
}

const isYear = n => /^(1[5-9]|20)\d\d$/.test(n);
function grounded(number, evidenceText) {
  const digits = number.replace(/[^\d.]/g, '').replace(/\.$/, '');
  if (!digits) return true;
  const flat = evidenceText.replace(/(\d),(?=\d{3})/g, '$1');
  if (flat.includes(digits)) return true;
  if (isYear(digits)) return false;
  const q = parseQuantity(number);
  if (!q) return false;
  for (const m of flat.matchAll(/-?\d+(?:\.\d+)?\s*(?:thousand|million|billion|trillion|bn|km2|km²|km|kilomet(?:er|re)s?|met(?:er|re)s?|m\b|cm|mm|ft|feet|foot|inch(?:es)?|miles?|kg|lbs?|pounds?|tonnes?|%)?/gi)) {
    const e = parseQuantity(m[0]);
    if (e && e.dimension === q.dimension && Math.abs(e.value - q.value) / Math.max(Math.abs(e.value), 1e-9) < 0.03) return true;
  }
  return false;
}

export function parseBlocks(markdown) {
  const blocks = [];
  let fence = null, para = null;
  for (const line of markdown.replace(/\r/g, '').split('\n')) {
    if (fence) { if (/^\s*```/.test(line)) { blocks.push(fence); fence = null; } else fence.text += line + '\n'; continue; }
    if (/^\s*```/.test(line)) { para = null; fence = { type: 'code', lang: line.trim().slice(3).trim(), text: '' }; continue; }
    if (!line.trim()) { para = null; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) { para = null; blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\*\*/g, '') }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      para = null;
      const last = blocks.at(-1);
      if (last?.type === 'table') last.rows.push(line); else blocks.push({ type: 'table', rows: [line] });
      continue;
    }
    const item = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)/);
    if (item) { para = null; blocks.push({ type: 'item', ordered: /\d/.test(item[2]), depth: item[1].length >= 2 ? 1 : 0, text: item[3] }); continue; }
    if (para) para.text += ' ' + line.trim(); else { para = { type: 'paragraph', text: line.trim() }; blocks.push(para); }
  }
  if (fence) blocks.push(fence);
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'item') block.sentences = sentences(block.text).map(text => ({ text }));
    if (block.type === 'table') block.cells = tableClaims(block.rows);
  }
  return blocks;
}

const splitRow = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
function tableClaims(rows) {
  const parsed = rows.map(splitRow).filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || !c));
  if (parsed.length < 2) return [];
  const [header, ...body] = parsed;
  const claims = [];
  body.forEach((row, ri) => row.forEach((cell, ci) => {
    if (ci === 0 || !cell || cell === '-' || cell === '—') return;
    const attribute = row[0].replace(/\*\*/g, ''), subject = (header[ci] || '').replace(/\*\*/g, '');
    claims.push({ row: ri, col: ci, text: `${subject} — ${attribute}: ${cell.replace(/\*\*/g, '')}.` });
  }));
  return claims;
}

const stripCites = text => text.replace(/\s*\[(?:\d+(?:\s*[,–-]\s*\d+)*)\]/g, '').trim();
const plainOf = text => stripCites(text).replace(/\*\*|__|`/g, '').trim();

export async function indexEvidence(evidence) {
  const units = [];
  for (const e of evidence) for (const line of String(e.text).split(/\n+/)) for (const s of sentences(line)) if (s.length > 12) units.push({ text: s, id: e.id });
  const vectors = await reflex.embed(units.map(u => u.text));
  units.forEach((u, i) => { u.vector = vectors[i]; });
  return { evidence, units };
}

export async function selectFacts(question, index, k) {
  const clean = t => t.replace(/^(?:[A-Z][a-z]{2} \d{1,2}, \d{4}|\d+ (?:hours?|days?) ago)\s*(?:\.\.\.|·|—|-)\s*/, '').replace(/\s*(?:\.\.\.|…)\s*$/, '.').trim();
  let pool = index.units
    .map(u => ({ ...u, text: clean(u.text), truncated: /(\.\.\.|…)\s*$/.test(u.text) }))
    .filter(u => u.text.length > 30 && u.text.length < 420 && !/^(Key points|Table of contents|Share|Read more|Click|Sign up)/i.test(u.text))
    .filter(u => (u.text.match(/\s[·•|]\s/g) || []).length < 2)
    .filter(u => !/(^|[\s"“(])I(\s|'m\b|'ve\b|'d\b)/.test(u.text));
  if (pool.filter(u => !u.truncated).length >= Math.max(6, k)) pool = pool.filter(u => !u.truncated);
  if (!pool.length) return [];
  const scores = await reflex.rerank(question, pool.map(u => u.text));
  pool.forEach((u, i) => { u.relevance = scores[i].p - (u.truncated ? 0.15 : 0); });
  const years = question.match(/\b(1[5-9]|20)\d\d\b/g);
  if (years) pool.forEach(u => { const own = u.text.match(/\b(1[5-9]|20)\d\d\b/g); if (own && !own.some(y => years.includes(y))) u.relevance -= 0.5; });
  const ranked = pool.sort((a, b) => b.relevance - a.relevance);
  const floor = k <= 5 ? 0.45 : 0.3;
  const candidates = ranked.filter((u, i) => u.relevance > floor || i < 3).slice(0, 40);
  const chosen = [];
  while (chosen.length < k && candidates.length) {
    let bestIndex = -1, bestValue = -Infinity;
    candidates.forEach((c, i) => {
      const overlap = chosen.length ? Math.max(...chosen.map(x => reflex.cosine(x.vector, c.vector))) : 0;
      if (overlap > 0.93) return;
      const value = 0.72 * c.relevance - 0.28 * overlap;
      if (value > bestValue) { bestValue = value; bestIndex = i; }
    });
    if (bestIndex < 0) break;
    chosen.push(candidates.splice(bestIndex, 1)[0]);
  }
  return chosen;
}

async function judge(claim, index, claimVector) {
  const ranked = index.units.map(u => ({ u, sim: reflex.cosine(claimVector, u.vector) })).sort((a, b) => b.sim - a.sim);
  const bySite = new Map();
  for (const { u, sim } of ranked) {
    const e = index.evidence.find(x => x.id === u.id);
    const site = e?.site || e?.host || `#${u.id}`;
    if (!bySite.has(site)) { if (bySite.size >= 5) continue; bySite.set(site, { units: [u], e }); }
    else if (bySite.get(site).units.length < 2 && sim > 0.55) bySite.get(site).units.push(u);
    if (bySite.size >= 5 && [...bySite.values()].every(s => s.units.length >= 2)) break;
  }
  const sites = [...bySite.entries()];
  const premises = [], owner = [];
  sites.forEach(([site, s], i) => {
    premises.push(s.units[0].text); owner.push(i);
    if (s.units[1]) { premises.push(`${s.units[0].text} ${s.units[1].text}`); owner.push(i); }
  });
  const fused = ranked.slice(0, 4).map(r => r.u);
  premises.push(fused.map(u => u.text).join(' '));
  const results = await reflex.nli(premises, premises.map(() => claim));
  const perSite = sites.map((_, i) => results.filter((_, k) => owner[k] === i).reduce((a, r) => r.entail > a.entail ? r : a, { entail: 0, contradict: 0 }));
  const agreeing = sites.filter((_, i) => perSite[i].entail >= 0.5);
  const bestIndex = perSite.reduce((b, r, i) => r.entail > (perSite[b]?.entail ?? -1) ? i : b, 0);
  const fusedResult = results.at(-1);
  const entail = Math.max(perSite[bestIndex]?.entail ?? 0, fusedResult.entail);
  const contradict = Math.max(...perSite.map(r => r.contradict), 0);
  const cites = agreeing.length ? agreeing.map(([, s]) => s.e.id).slice(0, 3)
    : (perSite[bestIndex]?.entail ?? 0) >= fusedResult.entail && sites[bestIndex] ? [sites[bestIndex][1].e.id] : [...new Set(fused.slice(0, 3).map(u => u.id))];
  return { entail, contradict, cites, sites: agreeing.map(([site]) => site), fusedOnly: !agreeing.length && fusedResult.entail >= 0.5 };
}

const CLAUSE = /,\s+(?=(?:which|who|while|whereas|but|and|although|though|often|with|including|such as|especially|as well as|thereby|where|after|before|since|when)\b)|,\s+(?=[a-z]+ing\b)|\s+(?=(?:in order )?to (?:build|make|create|develop|provide|help|offer|serve|support|become|focus|bring|deliver|enable|allow|compete|reach)\b)|;\s+|\s+—\s+|:\s+(?=[a-z])/i;

export async function checkSentence(sentence, index, { question = '', vector, mode = 'prose' } = {}) {
  const plain = plainOf(sentence);
  const tokens = words(plain);
  if (tokens.length < 4 || META.test(plain) || /\?$/.test(plain)) return { status: 'meta', cites: [] };
  const [claimVector] = vector ? [vector] : await reflex.embed([plain]);
  const whole = await judge(plain, index, claimVector);
  const all = index.evidence.map(e => e.text).join(' ') + ' ' + question;
  const numbers = numbersIn(plain);
  const missing = numbers.filter(n => !grounded(n, all));
  if (mode !== 'grounding') for (const m of plain.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?((?:1[5-9]|20)\d\d)\b/g)) {
    const near = new RegExp(String.raw`${m[1].slice(0, 3)}[a-z]*\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?${m[2]}|\b\d{1,2}\s+${m[1].slice(0, 3)}[a-z]*\.?\s+${m[2]}|${m[2]}-${String(['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(m[1]) + 1).padStart(2, '0')}`, 'i');
    if (!near.test(all)) missing.push(`${m[1]} ${m[2]}`);
  }
  if (missing.length) return { status: 'ungrounded', cites: [], entail: whole.entail, contradict: whole.contradict, missing };
  if (whole.entail >= 0.5 && mode !== 'grounding') {
    if (whole.fusedOnly) return { status: 'partial', cites: whole.cites, entail: whole.entail, contradict: whole.contradict, sites: [], fused: true };
    return { status: 'supported', cites: whole.cites, entail: whole.entail, contradict: whole.contradict, sites: whole.sites };
  }
  if (whole.entail >= 0.5) return { status: 'supported', cites: whole.cites, entail: whole.entail, contradict: whole.contradict };
  if (mode === 'grounding') {
    const names = plain.match(/[\w.-]+\.(?:[a-z0-9]{2,5})\b/gi)?.filter(n => /[a-z]/i.test(n.split('.').pop()) && !/^\d/.test(n)) || [];
    const paths = (plain.match(/(?:[A-Za-z]:\\|~\/|\/(?:Users|home|mnt|var|tmp)\/)[^\s`'"()]+/g) || []).map(p => p.replace(/[.,;:]+$/, ''));
    const lower = all.toLowerCase();
    const unknown = [...names, ...paths].filter(n => !lower.includes(n.toLowerCase()));
    if (unknown.length) return { status: 'ungrounded', cites: [], entail: whole.entail, missing: unknown };
    return { status: whole.entail >= 0.5 || names.length || numbers.length ? 'supported' : 'unverified', cites: whole.cites, entail: whole.entail };
  }
  if (whole.contradict >= 0.8 && whole.entail < 0.15) return { status: 'contradicted', cites: [], entail: whole.entail, contradict: whole.contradict };

  const clauses = plain.split(CLAUSE).map(c => c.trim()).filter(c => words(c).length >= 3);
  if (clauses.length >= 2) {
    const subject = plain.split(/\s+/).slice(0, 3).join(' ');
    const texts = clauses.map((c, i) => i === 0 ? c : `${/^(which|who|while|whereas|but|and|although|though|often|thereby|where|[a-z]+ing)\b/i.test(c) ? subject + ' ' + c.replace(/^(which|who|and|but)\s+/i, '') : c}`);
    const vectors = await reflex.embed(texts);
    const parts = await Promise.all(texts.map((t, i) => judge(t, index, vectors[i])));
    const supported = parts.filter(p => p.entail >= 0.5);
    const contradicted = parts.filter(p => p.contradict >= 0.8 && p.entail < 0.15);
    if (contradicted.length && !supported.length) return { status: 'contradicted', cites: [], entail: whole.entail, contradict: Math.max(...contradicted.map(p => p.contradict)) };
    if (supported.length / parts.length >= 0.5) {
      return { status: supported.length === parts.length ? 'supported' : 'partial', cites: [...new Set(supported.flatMap(p => p.cites))].slice(0, 3), entail: whole.entail, contradict: whole.contradict, clauses: texts.map((t, i) => ({ text: clauses[i], ok: parts[i].entail >= 0.5 })) };
    }
  }
  return { status: whole.entail >= 0.25 ? 'partial' : 'unverified', cites: whole.entail >= 0.25 ? whole.cites : [], entail: whole.entail, contradict: whole.contradict };
}

export async function checkCell(claim, index) {
  const [v] = await reflex.embed([claim.text]);
  const r = await judge(claim.text, index, v);
  const numbers = numbersIn(claim.text);
  const all = index.evidence.map(e => e.text).join(' ');
  const missing = numbers.filter(n => !grounded(n, all));
  return { ...claim, status: missing.length ? 'ungrounded' : r.entail >= 0.5 ? 'supported' : r.contradict >= 0.8 && r.entail < 0.15 ? 'contradicted' : r.entail >= 0.25 ? 'partial' : 'unverified', cites: r.entail >= 0.25 ? r.cites : [], entail: r.entail };
}

export function summarize(blocks) {
  const checked = blocks.flatMap(b => b.sentences || []).filter(s => s.status && s.status !== 'meta');
  const cells = blocks.flatMap(b => b.cells || []);
  const all = [...checked, ...cells];
  const count = status => all.filter(s => s.status === status).length;
  return {
    blocks,
    stats: { sentences: checked.length, cells: cells.length, supported: count('supported'), partial: count('partial'), unverified: count('unverified'), removed: count('contradicted') + count('ungrounded'), corroborated: checked.filter(s => (s.sites?.length || 0) >= 2).length, singleSource: checked.filter(s => s.status === 'supported' && s.sites?.length === 1).length },
    removed: all.filter(s => s.status === 'contradicted' || s.status === 'ungrounded').map(s => ({ text: s.text, status: s.status, missing: s.missing }))
  };
}

export { stripCites, numbersIn, grounded };
