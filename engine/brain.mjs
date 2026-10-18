import * as mouth from './mouth.mjs';
import * as reflex from './reflex.mjs';
import { decide, runTool, byId } from './tools/index.mjs';
import { research, vote as runVote, learnFromVote, expectedType, polarVote, POLAR, timeOf, dateOf } from './research.mjs';
import { researchPrompt, factsPrompt, chatPrompt, rewritePrompt } from './compose.mjs';
import { parseBlocks, checkSentence, checkCell, summarize, indexEvidence, selectFacts } from './verify.mjs';
import { flush as flushTrust, trust } from './trust.mjs';
import { classify, rewrite, contextPrompt } from './conversation.mjs';
import { hostOf, siteOf, sentences, words, keywords, longDate } from './util.mjs';

const FOLLOW_UP = /\b(he|she|it|they|him|her|his|hers|its|their|them|this|that|those|these|there|the same|the other|one|ones|former|latter)\b|^(and|what about|how about|why|so|also|then|but|what else|more on|tell me more|compare)\b/i;
const FRESH = /\b(current(ly)?|latest|now|today|tonight|tomorrow|yesterday|this (week|month|year|season)|recent(ly)?|newest|upcoming|still|score|news|live|right now|so far|the last|most recent|who won|next|20(2[5-9]|3\d))\b/i;
const CHANGING = /\b(richest|richer|wealthiest|net worth|ceo|president|prime minister|chancellor|leader of|head of|mayor|governor|king|queen|champions?|world record|record holder|population|price|prices|cost|costs|salary|rank(ed|ing)?|number one|tallest building|biggest company|most valuable|interest rates?|inflation rate|unemployment)\b/i;
const HISTORICAL = /\b(first|founded|founder|history|historical|originally|ancient|in the (18|19)\d\ds|in (1[0-9]|20[01])\d\d|during|was|were|did)\b/i;
const AUTHORITIES = [
  { topic: /\b(money|invest\w*|stocks?|shares|crypto\w*|bitcoin|ethereum|savings?|retire\w*|401k|ira|debt|loans?|mortgage|credit|budget\w*|tax(es)?|salary|bank\w*|interest rates?|funds?|etf|afford|insurance|pension)\b/i, sites: ['investor.gov', 'finra.org', 'consumerfinance.gov', 'investopedia.com', 'nerdwallet.com', 'bankrate.com'], formats: ['advice', 'explain', 'howto', 'compare'] },
  { topic: /\b(health|symptoms?|pain|doctor|medicines?|medications?|drugs?|diet|weight|sleep|anxiety|depress\w*|pregnan\w*|vaccines?|disease|sick|illness|injur\w*|headache|migraines?|fever|blood|heart|cancer|diabetes|vitamins?|supplements?|tylenol|advil|ibuprofen|acetaminophen|dehydrat\w*|allerg\w*)\b/i, sites: ['nih.gov', 'mayoclinic.org', 'cdc.gov', 'nhs.uk', 'clevelandclinic.org', 'medlineplus.gov'], formats: ['advice', 'explain', 'howto', 'compare', 'factoid'] },
  { topic: /\b(legal|law|lawyer|sue|lawsuit|contract|landlord|tenant|evict\w*|divorce|custody|visa|immigration|rights|court|fired|employer)\b/i, sites: ['law.cornell.edu', 'nolo.com', 'findlaw.com', 'usa.gov', 'consumerfinance.gov'], formats: ['advice', 'explain', 'howto'] },
  { topic: /\b(girlfriend|boyfriend|partner|wife|husband|marriage|married|relationship|dating|break ?up|friends?|family|parents?|lonely|loneliness|argu\w*|fight\w*|grief|stress\w*|motivat\w*|nervous|anxious)\b/i, sites: ['psychologytoday.com', 'gottman.com', 'verywellmind.com', 'helpguide.org', 'apa.org', 'mayoclinic.org'], formats: ['advice'] }
];
const authorityQuery = (question, format, base) => {
  const hit = AUTHORITIES.find(a => a.formats.includes(format) && a.topic.test(question));
  return hit ? `${base.replace(/[?.!]+$/, '')} (${hit.sites.map(d => `site:${d}`).join(' OR ')})` : null;
};

const isFresh = q => FRESH.test(q) || (CHANGING.test(q) && !HISTORICAL.test(q));
const ALTERNATIVE = /\bor\b(?!\s+not\b)/i;
const DERIVED = /\bhow old (was|were|will|is|would)\b[^?]*\b(when|at the time|by the time|in \d{4})\b|\bhow (many|much) (years?|days?|months?|weeks?|hours?|times)\b[^?]*\b(between|after|before|since|until|from|older|younger|bigger|larger|longer|than)\b|\bhow long ago\b|\bhow (much|many times) (older|younger|bigger|taller|longer|heavier|larger|richer|more|less|cheaper)\b|\bhow much would\b[^?]*\b(cost|be)\b[^?]*\b(current|today'?s?|average|now)\b/i;

const PERSONAL = { test: q => /\b(should|worth|afford|i'm|im|i've|i'd|my|we|our)\b/i.test(q) || /(^|[^\w])I\b(?! (?:War|II)\b)/.test(q) };
const META_TALK = /\b(I have (analy[sz]ed|performed|reviewed|researched|checked|gathered|compiled)|based on the (data|facts|information|evidence|research)( provided| given)?|according to the (facts|data|information|evidence)( provided| given)?|the (facts|evidence|sources) (provided|given)|(confirmed|verified|cross-checked|backed|supported) by (\w+ ){0,4}(independent )?(sources|sites)|(independent )?(sources|sites) (agree|confirm)|\b(the|this|these) (provided |given |available |supplied )?(evidence|sources|facts provided|passages|search results)\b|as an AI)\b/i;
const ADVISES_MORE = /\b(approach|option|choice|plan) (would be|is) to\b|\bwould be (wise|better|best|smart|safer)\b|\b(keep|put|invest|move|spend|save|use|avoid|consider|stick) (your|it|the|a|some|all|with)\b|\binstead\b/i;
const ADVISES = /\b(should|try|consider|engage|avoid|make sure|next step|recommend|suggest|experts? (say|suggest|recommend|agree|note|advise)|you (can|could|might|need to|have to|must)|it'?s (best|better|wise|important|smart) to|instead of|rather than|such as|for example)\b|^(try|use|avoid|start|stop|make|take|give|tell|ask|talk|engage|consider|do|don'?t|keep|set|go|get|buy|sell|invest|put|move|leave|quit)\b/i;
const RISKY = /\b(no need to|don'?t (need|have) to|don'?t worry|never need|(always|completely|perfectly|totally) safe|guarantee[ds]?|cures?|100 ?%|risk[- ]free|can'?t go wrong|nothing to worry)\b/i;

const CRISIS = /\b(kill(ing)? myself|suicid(e|al)|end (it all|my life)|take my (own )?life|self[- ]?harm|hurt(ing)? myself|cut(ting)? myself|(don'?t|do not) want to (live|be alive|wake up)|want to die|better off dead|no reason to live)\b/i;
const HELPLINES = `**If you are in immediate danger, call your local emergency number now** (911 in the US and Canada, 112 in the EU, 999 in the UK).

- **US & Canada:** call or text **988** (Suicide & Crisis Lifeline), any time
- **UK & Ireland:** Samaritans, **116 123**, free, any time
- **Anywhere else:** findahelpline.com lists free, confidential lines in your country`;
async function crisisReply(prompt, history, emit, signal) {
  const { text } = await mouth.say([
    { role: 'system', content: 'Someone may be thinking about hurting themselves. Reply in two or three short, warm, human sentences: say you are glad they told you, that what they feel matters, and gently encourage them to reach out to a crisis line or someone they trust right now. No advice lists, no lecturing, no questions about methods.' },
    { role: 'user', content: prompt }
  ], { maxTokens: 120, temperature: 0.4, signal });
  const reply = `${text.trim()}\n\n${HELPLINES}\n\nI'm here to keep talking if you want to.`;
  emit({ type: 'token', text: reply });
  return reply;
}

const FORMAT_EXAMPLES = {
  factoid: ['who is the CEO of Apple', 'when did the Berlin Wall fall', 'what is the capital of Peru', 'how tall is Mount Everest', 'who won the last world cup', 'what is the population of Brazil', 'who wrote Hamlet', 'who founded Nvidia', 'how much does a Tesla cost', 'who is the mayor of Chicago'],
  explain: ['how do vaccines work', 'what is inflation', 'why is the sky blue', 'explain blockchain simply', 'what is retrieval augmented generation', 'how does a car engine work', 'what is Ozempic', 'is it safe to eat eggs every day', 'why is my wifi slow', 'what causes acne', 'what causes inflation', 'how does the stock market work'],
  howto: ['how do I get rid of fruit flies', 'how to change a tire', 'how long should I boil an egg', 'best way to learn Spanish fast', 'steps to start a small business', 'how can I sleep better', 'how do I clean a cast iron pan', 'how do I make my laptop faster'],
  list: ['recommend a good sci-fi book', 'best laptops for students', 'top things to do in Rome', 'examples of renewable energy', 'good movies to watch this weekend', 'what are some healthy snacks'],
  advice: ['should I break up with my girlfriend', 'should I quit my job', 'is it worth buying a used car right now', 'I am nervous about my job interview tomorrow', 'should I put my savings into crypto', 'my friend keeps ignoring me what should I do', 'should I learn Python or JavaScript first', 'I feel lonely lately', 'should I move to another city for a job'],
  news: ['what happened with the election', 'latest news about the war', 'what happened to the Titan submarine', 'what is going on with Tesla stock this week', 'any news about the Mars mission'],
  code: ['write a python function to reverse a string', 'how do I fix this javascript error', 'regex to match an email address', 'sql query to find duplicate rows', 'how do I center a div in CSS', 'how to read a file in python', 'javascript array map example', 'git command to undo the last commit', 'how do I make an HTTP request in node']
};
let formatVectors = null;
export async function formatFor(q) {
  if (/\b(vs\.?|versus|compare|comparison|difference(s)? between|pros and cons|which is better)\b/i.test(q)) return 'compare';
  if (/\bor\b(?!\s+not\b)[^?]*\b(better|worse|safer|healthier|cheaper|faster|stronger|richer|bigger|smaller|smarter|easier|harder)\b|\b(better|worse|safer|healthier|cheaper|faster|stronger|richer|bigger|smaller|smarter|easier|harder)\b[^?]*\bor\b(?!\s+not\b)/i.test(q)) return 'compare';
  if (/\b(code|function|script|regex|sql|python|javascript|typescript|java|c\+\+|c#|rust|golang|bash|powershell)\b/i.test(q) && /\b(write|implement|snippet|error|exception|bug|syntax|traceback)\b/i.test(q)) return 'code';
  if (POLAR.test(q.trim()) && !PERSONAL.test(q) && !ALTERNATIVE.test(q)) return 'factoid';
  formatVectors ||= await (async () => {
    const rows = Object.entries(FORMAT_EXAMPLES).flatMap(([format, list]) => list.map(text => ({ format, text })));
    const vectors = await reflex.embed(rows.map(r => r.text));
    return rows.map((r, i) => ({ ...r, v: vectors[i] }));
  })();
  const [v] = await reflex.embed([q]);
  const best = {};
  for (const row of formatVectors) { const s = reflex.cosine(v, row.v); if (!best[row.format] || s > best[row.format]) best[row.format] = s; }
  const [format, score] = Object.entries(best).sort((a, b) => b[1] - a[1])[0];
  if (score < 0.72 && expectedType(q) !== 'any') return 'factoid';
  return format;
}

export function formatOf(q) {
  if (/^(should i|should we|do i|would it be (wise|smart|a good idea)|is it (worth|wise|smart|a good idea|bad|ok|okay)|am i|what should i|how do i (know|tell|decide)|can i afford|i('m| am) (thinking|considering|wondering)|i (feel|think|want|need|have)\b)/i.test(q.trim()) || /\b(should i|my (girlfriend|boyfriend|wife|husband|partner|boss|friend|parents?|mom|dad)|is it worth (it|my))\b/i.test(q)) return 'advice';
  if (/\b(vs\.?|versus|compare|comparison|difference(s)? between|better than|pros and cons)\b/i.test(q)) return 'compare';
  if (/^(how (do|can|should|would) (i|you|we|one)|how to|steps? (to|for)|guide (to|for)|ways to|what's the best way to|what is the best way to)\b/i.test(q)) return 'howto';
  if (/\b(news|latest developments|what happened|update on|this week in)\b/i.test(q)) return 'news';
  if (/^(list|name (some|the|a few)|what are (some|the (main|best|top|different|types))|top \d+|best \w+( \w+)? (for|to|in)|examples of|types of|kinds of)\b/i.test(q)) return 'list';
  if (/\b(code|function|script|regex|sql|python|javascript|typescript|java|c\+\+|c#|rust|golang|bash|powershell|css|html|react|node)\b/i.test(q) && /\b(write|how (do|to|can)|example|implement|snippet|error|fix|bug|syntax|convert)\b/i.test(q)) return 'code';
  if (expectedType(q) !== 'any') return 'factoid';
  if (/^(who|when|where|which)\b|^what (is|was|are) the (name|capital|population|date|year|height|age|currency)\b/i.test(q)) return 'factoid';
  return 'explain';
}

function compareQueries(q) {
  const m = q.match(/(?:difference(?:s)? between|compare)\s+(.+?)\s+(?:and|with|to|vs\.?|versus)\s+(.+?)(?:\?|$| in terms| for )/i) || q.match(/^(.+?)\s+(?:vs\.?|versus|or)\s+(.+?)(?:\?|$|:| for | which)/i);
  return m ? [m[1], m[2]].map(s => s.replace(/^(what is the|what's the|is|are|should i (use|buy|get|choose))\s+/i, '').trim()).filter(s => s.length > 1) : [];
}

const NEGATION = /\b(not|never|no|cannot|none|nothing|nobody)\b|n't\b/gi;
const negations = text => (String(text).match(NEGATION) || []).length;
function samePolarity(question, statement) {
  const asked = negations(question.replace(/^\s*\w+n't\b/i, ''));
  let s = statement;
  if (negations(s) > asked && asked === 0) {
    s = s.replace(/\bcannot\b/gi, 'can').replace(/\b(ca|wo)n't\b/gi, (m, w) => w.toLowerCase() === 'wo' ? 'will' : 'can')
      .replace(/\b(do|does|did) not\s+|\b(do|does|did)n't\s+/gi, '').replace(/\b(\w+)n't\b/gi, '$1').replace(/\s+(not|never)\b/gi, '').replace(/\s{2,}/g, ' ');
  }
  return negations(s) === asked ? s : null;
}
async function statementOf(question, signal) {
  const out = await mouth.json([
    { role: 'system', content: 'Turn the yes/no question into the statement it asks about, worded the same way as the question even when you think the answer is no. Keep every word that carries meaning. Output JSON.' },
    { role: 'user', content: 'Is Pluto a planet?' }, { role: 'assistant', content: '{"statement":"Pluto is a planet."}' },
    { role: 'user', content: 'Can cats eat chocolate?' }, { role: 'assistant', content: '{"statement":"Cats can eat chocolate."}' },
    { role: 'user', content: 'Does coffee dehydrate you?' }, { role: 'assistant', content: '{"statement":"Coffee dehydrates you."}' },
    { role: 'user', content: 'Can you see the Great Wall of China from space?' }, { role: 'assistant', content: '{"statement":"The Great Wall of China can be seen from space."}' },
    { role: 'user', content: question }
  ], { type: 'object', properties: { statement: { type: 'string' } }, required: ['statement'] }, { maxTokens: 80, signal }).catch(() => null);
  const statement = String(out?.statement || '').trim();
  return statement.length > 5 && !/\?$/.test(statement) ? samePolarity(question, statement) : null;
}

function resolveTime(q) {
  const now = new Date(), year = now.getFullYear();
  const day = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const shift = n => new Date(now.getTime() + n * 864e5);
  const before = q.replace(/\?+$/, '');
  let t = before
    .replace(/\b(this|the current) (year|season)\b/gi, String(year)).replace(/\blast year\b/gi, String(year - 1)).replace(/\bnext year\b/gi, String(year + 1))
    .replace(/\bthis month\b/gi, `${now.toLocaleString('en-US', { month: 'long' })} ${year}`)
    .replace(/\b(today|tonight)\b/gi, day(now)).replace(/\btomorrow\b/gi, day(shift(1))).replace(/\byesterday\b/gi, day(shift(-1)));
  const when = timeOf(q);
  if (when && t === before) {
    const bare = t.replace(/\b(the\s+)?(very\s+)?(last|previous|next|upcoming|coming)\s+/i, '');
    if (bare !== t) t = when === 'next' ? `${bare} ${now.toLocaleString('en-US', { month: 'long' })} ${year}` : `${bare} ${year}`;
  }
  return t !== before ? t : null;
}
const INSTRUCTION_HEAD = /^(?:(?:can|could|would) (?:you|u)\s+|please\s+|pls\s+)*(?:summari[sz]e|explain|describe|tell me (?:about|what)?|give me(?: a)?(?: quick| short| brief| simple)?(?: summary| overview| rundown| explanation)?(?: of| on)?|write(?: me)?(?: a)? (?:summary|overview) of|what do you know about|break down)\s+/i;
const INSTRUCTION_TAIL = /\s*,?\s*(?:(?:in|using|with) (?:\d+|one|two|three|four|five|a few) (?:sentences?|words?|paragraphs?|bullet points?|points|lines)|in simple (?:terms|words)|simply|briefly|in detail|like (?:i'?m|im|i am) (?:5|five|a (?:kid|child|beginner))|for (?:a )?(?:beginners?|kids|dummies)|eli5)\s*[?.!]*$/i;
function topicOf(q) {
  const t = q.trim().replace(INSTRUCTION_TAIL, '').replace(INSTRUCTION_HEAD, '').trim();
  return t && t.toLowerCase() !== q.trim().toLowerCase() ? t : null;
}
function styleOf(q) {
  const parts = [];
  const n = q.match(/\b(?:in|using|with) (\d+|one|two|three|four|five|six|seven|eight|nine|ten) (sentences?|words?|paragraphs?|bullet points?|points|lines)\b/i);
  if (n) parts.push(`exactly ${n[1]} ${n[2]}.`);
  if (/like (i'?m|im|i am) (5|five|a (kid|child))|\beli5\b|for (kids|a child)/i.test(q)) parts.push('explain it as you would to a five-year-old: very simple words, one everyday comparison, no jargon.');
  else if (/in simple (terms|words)|\bsimply\b|for (a )?beginners?|for dummies/i.test(q)) parts.push('simple everyday words, no jargon.');
  if (/\b(briefly|short answer|in short|tl;?dr)\b/i.test(q)) parts.push('keep it very short.');
  return parts.join(' ');
}
const SAFE_CONSTANTS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 24, 28, 29, 30, 31, 32, 52, 60, 100, 365, 366, 1000, 3600, 5280, 86400, 1.8, 2.54, 0.3048, 3.28084, 1.60934, 0.621371, 2.20462, 0.453592, 3.78541, 273.15, 1e3, 1e6, 1e9]);
function invented(solved, text) {
  const known = new Set((String(text).replace(/,(?=\d{3})/g, '').match(/\d+(?:\.\d+)?/g) || []).map(Number));
  const stated = n => known.has(n) || known.has(+(n * 100).toFixed(6)) || known.has(+(n / 100).toFixed(6));
  const plain = String(text).replace(/,(?=\d{3})/g, '');
  const esc = n => String(n).replace('.', '\\.');
  const asMoney = n => new RegExp(String.raw`[$€£¥]\s?${esc(n)}(?![\d]|\.\d)|(^|[^\d.])${esc(n)}(?![\d]|\.\d)\s?(dollars?|usd|eur|euros?|pounds?|cents?|per|a (gallon|litre|liter|month|year|hour|kg|lb)|/)`, 'i').test(plain);
  const worldly = [...String(solved?.program || '').matchAll(/\b\w*?(price|cost|fee|tax|salary|wage|avg|average|rate|value|population|distance|speed|height|weight|age)\w*\s*=\s*(\d+(?:\.\d+)?)/gi)]
    .map(m => ({ n: Number(m[2]), money: /price|cost|fee|tax|salary|wage|avg|average/i.test(m[0].split('=')[0]) }));
  return [...new Set([...(solved?.constants || []).filter(n => !SAFE_CONSTANTS.has(n) && !stated(n)), ...worldly.filter(w => w.money ? !asMoney(w.n) : !stated(w.n)).map(w => w.n)])];
}
async function inputsOf(question, signal) {
  const age = question.replace(/\?+$/, '').match(/\bhow old (?:was|were|is|will|would)\s+(.+?)\s+(?:be\s+)?when\s+(?:he|she|they|it)?\s*(.+)$/i);
  const name = age?.[1].replace(/\b\p{L}/gu, c => c.toUpperCase());
  if (age) return [`When was ${name} born?`, `When ${name} ${age[2]}?`];
  const out = await mouth.json([
    { role: 'system', content: 'List the facts that must be looked up to work out the answer, each as a short standalone question. Two or three at most. Output JSON.' },
    { role: 'user', content: 'How old was Marie Curie when she won her first Nobel Prize?' }, { role: 'assistant', content: '{"questions":["When was Marie Curie born?","When did Marie Curie win her first Nobel Prize?"]}' },
    { role: 'user', content: 'How much would 15 gallons of gas cost at the current US average price?' }, { role: 'assistant', content: '{"questions":["What is the current average price of a gallon of gas in the US?"]}' },
    { role: 'user', content: question }
  ], { type: 'object', properties: { questions: { type: 'array', items: { type: 'string' }, maxItems: 3 } }, required: ['questions'] }, { maxTokens: 120, signal }).catch(() => null);
  const asked = new Set(words(question).filter(w => w.length > 2));
  const restates = q => { const w = words(q).filter(x => x.length > 2); return w.length && w.filter(x => asked.has(x)).length / w.length > 0.8 && /\bhow (old|many|much|long)\b/i.test(q); };
  return (out?.questions || []).map(q => String(q).trim()).filter(q => q.length > 8 && q.length < 160 && !restates(q) && !DERIVED.test(q) && !/^how (old|many|much|long)\b/i.test(q)).slice(0, 3);
}

function statementFor(question, answer) {
  const m = question.trim().replace(/\?+$/, '').replace(/^(who|what|which)['’]?s\b/i, '$1 is').match(/^(?:who|what|which(?: [\w-]+){0,2})\s+(is|are|was|were|won|wins|founded|created|invented|wrote|directed|owns|runs|leads|discovered|made|built|designed|plays|played|sang|painted|holds|has|became|coaches|manages|chairs|heads)\b\s*(.*)$/i);
  return m ? `${answer} ${m[1]} ${m[2]}`.trim().replace(/\s+/g, ' ') + '.' : null;
}
async function checkVote(vote, question, index) {
  if (!vote?.clusters?.length || vote.type !== 'entity' || / and /.test(vote.answer || '')) return;
  const contenders = vote.clusters.slice(0, 4).filter(c => c.weight >= 0.12 * vote.clusters[0].weight);
  const tested = (await Promise.all(contenders.map(async c => {
    const statement = statementFor(question, c.answer);
    const r = statement ? await polarVote(statement, index) : null;
    return r ? { c, r, score: r.yes.length - 2 * r.no.length } : null;
  }))).filter(Boolean);
  if (!tested.length) return;
  const leader = tested.find(t => t.c === vote.clusters[0]);
  if (leader?.r.no.length && !tested.some(t => t !== leader && t.r.yes.length)) {
    const spans = (await reflex.extract(question, leader.r.no.map(x => x.text), { k: 3 })).flat();
    const fresh = [...new Set(spans.filter(s => s.score > 0.05 && /\p{Lu}/u.test(s.answer) && s.answer.length < 60).map(s => s.answer.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '')))]
      .filter(a => a && !vote.clusters.slice(0, 4).some(c => c.answer.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(c.answer.toLowerCase()))).slice(0, 3);
    for (const answer of fresh) {
      const statement = statementFor(question, answer);
      const r = statement ? await polarVote(statement, index) : null;
      if (r) tested.push({ c: { answer, weight: 0, sites: r.yes.map(x => x.site), members: [{ passage: { text: r.yes[0]?.text || '', url: '' } }] }, r, score: r.yes.length - 2 * r.no.length });
    }
  }
  const best = tested.slice().sort((a, b) => b.score - a.score)[0];
  vote.checked = tested.map(t => ({ answer: t.c.answer, supported: t.r.yes.map(x => x.site), contradicted: t.r.no.map(x => x.site) }));
  if (best.c !== vote.clusters[0] && best.score > (leader?.score ?? 0) && best.r.yes.length) {
    if (!vote.clusters.includes(best.c)) vote.clusters.unshift(best.c);
    vote.clusters = [best.c, ...vote.clusters.filter(c => c !== best.c)];
    vote.answer = best.c.answer;
    vote.agree = new Set([...best.c.sites, ...best.r.yes.map(x => x.site)]).size;
    vote.supporters = [...new Set([...best.c.sites, ...best.r.yes.map(x => x.site)])];
    vote.settled = best.r.yes.length >= 2 && !best.r.no.length;
    vote.alternatives = [best.c, ...vote.alternatives.filter(a => a.answer !== best.c.answer).map(a => vote.clusters.find(c => c.answer === a.answer) || a)].slice(0, 4).map(c => c.members ? { answer: c.answer, share: c.weight / (vote.clusters.reduce((s, x) => s + x.weight, 0) || 1), sites: c.sites, quote: c.members[0].passage.text, url: c.members[0].passage.url } : c);
    vote.overruled = true;
  } else if (leader && leader.r.no.length >= 2 && !leader.r.yes.length) vote.settled = false;
  else if (leader && leader.r.yes.length >= 2 && !leader.r.no.length && vote.agree >= 2) vote.settled = true;
}

function quantityIn(question, args = {}) {
  const used = JSON.stringify(args).toLowerCase();
  const argWords = Object.values(args).filter(v => typeof v === 'string' && /^[\w.-]{2,20}$/.test(v)).map(v => v.toLowerCase().replace(/[.-]/g, '\\$&'));
  const q = question.replace(/,(?=\d{3})/g, '');
  const patterns = [
    /[$€£¥]\s?\d[\d.]*/,
    /\b\d[\d.]*\s*(k|m|million|thousand|%|percent|dollars?|bucks|usd|eur|euros?|pounds?|gbp|yen|shares?|coins?|tokens?|units?|mph|km\/h|kph|miles?|km|kilomet(er|re)s?|hours?|minutes?|days?|weeks?|months?|years?|liters?|litres?|gallons?|people|times)\b/i,
    /\b(with|for|buy|sell|have|own|invest(ed)?|spend|put|of)\s+\d/i,
    ...(argWords.length ? [new RegExp(String.raw`\b\d[\d.]*\s*(${argWords.join('|')})\b`, 'i')] : [])
  ];
  const match = patterns.map(p => q.match(p)?.[0]).find(Boolean);
  if (!match) return false;
  const number = match.match(/\d[\d.]*/)[0];
  return !/^(19|20)\d\d$/.test(number) && !new RegExp(String.raw`(^|[^\d.])${number.replace('.', '\\.')}([^\d.]|$)`).test(used);
}

const toEvidence = (tool, startId) => {
  const site = tool.sources?.[0]?.url ? siteOf(tool.sources[0].url) : 'computed';
  const passages = tool.passages || [];
  return [
    ...tool.facts.map((text, i) => ({ id: startId + i, text, url: tool.sources?.[0]?.url || '', title: tool.sources?.[0]?.title || tool.title, site, host: hostOf(tool.sources?.[0]?.url || '') || tool.title, section: tool.title, trust: tool.trust || 0.95, tool: tool.id, relevance: 1 })),
    ...passages.map((p, i) => ({ ...p, id: startId + tool.facts.length + i, relevance: 0.8 }))
  ];
};

export async function answer(task, { emit, signal, confirm }) {
  const timings = {};
  const mark = (name, since) => { timings[name] = Math.round(performance.now() - since); };
  const t0 = performance.now();
  const stage = (name, detail = {}) => emit({ type: 'stage', stage: name, ...detail, at: Math.round(performance.now() - t0) });
  const history = task.history || [];

  if (CRISIS.test(task.prompt)) {
    const text = await crisisReply(task.prompt, history, emit, signal);
    return { mode: 'chat', question: task.prompt, answer: text, blocks: parseBlocks(text).map(b => ({ ...b, sentences: (b.sentences || []).map(s => ({ ...s, status: 'meta' })) })), sources: [], evidence: [], cards: [], vote: null, stats: null, timings: { total: Math.round(performance.now() - t0) } };
  }

  stage('understand');
  let question = task.prompt.trim();
  if (history.length && task.mode !== 'act') {
    const t = performance.now();
    const state = await classify(question, history);
    emit({ type: 'context', ...state });
    if (state.kind === 'context') {
      stage('speak', { mode: 'context' });
      const { text } = await mouth.say(contextPrompt(question, history), { signal, maxTokens: 500, temperature: 0.3, onToken: piece => emit({ type: 'token', text: piece }) });
      const blocks = parseBlocks(tidy(text, question));
      const evidence = history.slice(-4).map((h, i) => ({ id: i + 1, text: String(h.answer || ''), site: 'conversation', host: 'earlier in this chat', title: h.question }));
      const index = await indexEvidence(evidence);
      await Promise.all(blocks.flatMap(b => (b.sentences || []).map(s => checkSentence(s.text, index, { question, mode: 'grounding' }).then(r => Object.assign(s, r)))));
      const summary = summarize(blocks);
      for (const b of summary.blocks) if (b.sentences) b.sentences = b.sentences.filter(s => s.status !== 'ungrounded');
      mark('context', t);
      return { mode: 'context', question, answer: render(summary.blocks), blocks: summary.blocks, stats: summary.stats, removed: summary.removed, sources: [], evidence, cards: [], vote: null, timings: { ...timings, total: Math.round(performance.now() - t0) } };
    }
    if (state.kind === 'rewrite') {
      question = await rewrite(question, history, signal);
      const plain = t => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (plain(question) !== plain(task.prompt)) emit({ type: 'readAs', text: question });
    }
    mark('rewrite', t);
  }
  const t1 = performance.now();
  const route = await decide(question, { signal });
  if (task.mode === 'act') Object.assign(route, { mode: 'act', tool: null });
  else if (task.mode === 'chat') Object.assign(route, { mode: 'chat', tool: null });
  else if (task.mode === 'research' && route.mode !== 'research') Object.assign(route, { mode: 'research', tool: null });
  mark('route', t1);
  const natural = await formatFor(question);
  const calculation = route.tool && byId[route.tool.id].family === 'Compute' && !/\b(should|worth|wise|smart|good idea|better|best|recommend|advice|advise)\b/i.test(question);
  const advice = natural === 'advice' && !calculation && (PERSONAL.test(question) || !route.tool) && !(route.tool && byId[route.tool.id].decides);
  let format = route.tool && byId[route.tool.id].standalone && !advice && !/\b(than|instead of|alternatives? (to|for)|compared (to|with)|rather than|other than|similar to)\b/i.test(question) ? 'tool' : natural === 'advice' && !advice ? 'explain' : natural;
  stage('route', { mode: route.mode, tool: route.tool ? { id: route.tool.id, title: byId[route.tool.id].title, sim: route.tool.sim, by: route.tool.by, args: route.tool.args } : null, format, ranked: route.ranked, ms: timings.route });

  if (route.mode === 'act') {
    const { act } = await import('./agent.mjs');
    const result = await act({ prompt: question }, { emit, signal, confirm, history });
    result.blocks ||= parseBlocks(result.answer);
    result.timings = { ...timings, ...result.timings, total: Math.round(performance.now() - t0) };
    return result;
  }

  if (route.mode !== 'research') {
    stage('speak', { mode: route.mode });
    const t = performance.now();
    const { text } = await mouth.say(chatPrompt({ message: task.prompt, history, kind: route.mode }), { signal, maxTokens: route.mode === 'chat' ? 220 : 700, temperature: route.mode === 'creative' ? 0.8 : 0.4, onToken: (piece) => emit({ type: 'token', text: piece }) });
    mark('speak', t);
    const blocks = parseBlocks(text).map(b => b.sentences ? { ...b, sentences: b.sentences.filter(s => !META_TALK.test(s.text)) } : b).filter(b => !b.sentences || b.sentences.length);
    for (const b of blocks) for (const s of b.sentences || []) s.status = 'meta';
    return { mode: route.mode, question, answer: blocks.length ? render(blocks) : text, blocks, sources: [], evidence: [], cards: [], vote: null, stats: null, timings: { ...timings, total: Math.round(performance.now() - t0) } };
  }

  const toolRuns = [];
  const cards = [];
  if (route.tool) toolRuns.push({ id: route.tool.id, args: route.tool.args });
  const type = expectedType(question);
  const comparing = /\b(than|instead of|alternatives? (to|for)|compared (to|with)|rather than|other than|similar to)\b/i.test(question);
  let standalone = Boolean(route.tool && byId[route.tool.id].standalone) && !advice && !comparing;
  const boosters = () => {
    const runs = [];
    if ((type !== 'any' || natural === 'factoid') && route.tool?.id !== 'wikidata') runs.push({ id: 'wikidata', args: { question }, booster: true });
    if (byId.worldbank.pattern.test(question) && route.tool?.id !== 'worldbank') { const args = byId.worldbank.extract(question); if (args) runs.push({ id: 'worldbank', args, booster: true }); }
    return runs;
  };
  if (!standalone) toolRuns.push(...boosters());

  const tTools = performance.now();
  const runTools = runs => Promise.all(runs.map(async run => {
    emit({ type: 'tool', id: run.id, title: byId[run.id].title, status: 'running', args: run.args, booster: Boolean(run.booster) });
    try {
      const result = await runTool(run.id, run.args, { question, signal });
      emit({ type: 'tool', id: run.id, title: byId[run.id].title, status: 'done', ms: result.ms, facts: result.facts.length, booster: Boolean(run.booster) });
      if (result.card) cards.push({ tool: run.id, ...result.card });
      if (result.card) emit({ type: 'card', card: { tool: run.id, ...result.card } });
      return result;
    } catch (error) {
      emit({ type: 'tool', id: run.id, title: byId[run.id].title, status: 'failed', error: error.message, booster: Boolean(run.booster) });
      return null;
    }
  }));

  const polarQuestion = POLAR.test(question) && !PERSONAL.test(question) && !ALTERNATIVE.test(question) && natural !== 'advice';
  const statementPromise = polarQuestion ? statementOf(question, signal) : Promise.resolve(null);
  let toolPromise = runTools(toolRuns);
  const tools = standalone ? await toolPromise : null;
  if (standalone && tools?.[0] && byId[tools[0].id].feedsMath && quantityIn(question, tools[0].args)) {
    emit({ type: 'tool', id: 'solve', title: byId.solve.title, status: 'running', args: { problem: question } });
    try {
      const solved = await runTool('solve', { problem: `FACTS: ${tools[0].facts.join(' ')}\nQUESTION: ${question}` }, { question, signal });
      emit({ type: 'tool', id: 'solve', title: byId.solve.title, status: 'done', ms: solved.ms, facts: solved.facts.length });
      if (solved.card) { cards.unshift({ tool: 'solve', ...solved.card }); emit({ type: 'card', card: { tool: 'solve', ...solved.card } }); }
      tools.unshift(solved);
    } catch (error) {
      emit({ type: 'tool', id: 'solve', title: byId.solve.title, status: 'failed', error: error.message });
    }
  }
  let derive = DERIVED.test(question);
  if (standalone && tools?.[0]?.id === 'solve' && invented(tools[0], `${question} ${tools.slice(1).flatMap(t => t.facts || []).join(' ')}`).length) { derive = true; tools.splice(0); cards.splice(0); }
  if (standalone && !tools?.[0]) {
    standalone = false;
    format = natural === 'advice' && !advice ? 'explain' : natural;
    toolPromise = runTools(boosters());
  }
  const needResearch = !standalone;
  let found = { evidence: [], sources: [], pages: 0, results: 0 };
  let focus = null, inputs = [], inputFacts = Promise.resolve([]);
  let toolResults;
  if (needResearch) {
    const tResearch = performance.now();
    const situation = question.replace(/[,.]?\s*(what (should|do|can|could) (i|we) do|any (tips|advice|ideas)|help( me)?|please|what now)\s*\??$/i, '').replace(/^(should|do|am|can|would|is it)\s+(i|we)\s+/i, '').replace(/\?$/, '');
    const queries = format === 'compare' ? compareQueries(question) : format === 'advice' ? [`${situation} expert advice`] : [];
    const authority = authorityQuery(question, format, format === 'advice' ? situation : (topicOf(question) || question));
    if (authority) queries.unshift(authority);
    const topic = topicOf(question);
    if (isFresh(question) && !/\b20\d\d\b/.test(question)) {
      const year = new Date().getFullYear();
      focus = resolveTime(topic || question) || `${(topic || question).replace(/\?$/, '')} ${year}`;
      if (format === 'compare') for (let i = 0; i < queries.length; i++) queries[i] = `${queries[i]} ${year}`;
    }
    focus ||= topic;
    inputs = derive ? await inputsOf(question, signal) : [];
    if (inputs.length) queries.unshift(...inputs.slice(0, 2));
    inputFacts = Promise.all(inputs.map(input => runTool('wikidata', { question: input }, { question: input, signal }).catch(() => null)));
    const fresh = isFresh(question);
    stage('search', { queries: [...(focus ? [focus] : []), question, ...queries], fresh });
    [found, toolResults] = await Promise.all([
      research(question, { queries, focus, fresh, news: format === 'news', signal, emit: (kind, detail) => emit({ type: 'research', kind, ...detail }) }),
      toolPromise
    ]);
    mark('research', tResearch);
  } else toolResults = tools;
  mark('tools', tTools);
  if (signal?.aborted) throw new Error('stopped');
  toolResults = (toolResults || []).filter(Boolean);
  if (!standalone && /\b(today|tonight|tomorrow|yesterday|right now|this (weekend|week|morning|evening)|open|closed|how long ago|how many days)\b/i.test(question)) {
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    toolResults.push({ id: 'today', title: 'Today', family: 'Compute', facts: [`Today is ${longDate()}, and the local time is ${time}.`], sources: [], booster: true, ms: 0, trust: 0.99 });
  }

  let evidence = [];
  for (const tool of toolResults) {
    if (!standalone && !derive && tool.facts?.length && tool.id !== 'read_url' && tool.id !== 'today') {
      const scores = await reflex.rerank(question, tool.facts);
      tool.facts = tool.facts.filter((_, i) => scores[i].p >= 0.25);
      if (!tool.facts.length) { const at = cards.findIndex(c => c.tool === tool.id); if (at >= 0) cards.splice(at, 1); continue; }
    }
    evidence.push(...toEvidence(tool, evidence.length + 1));
  }
  const maxWeb = toolResults.some(t => !t.booster && t.passages?.length) ? 4 : 8;
  for (const e of found.evidence.slice(0, maxWeb)) evidence.push({ ...e, id: evidence.length + 1 });
  const linked = toolResults.find(t => t.id === 'read_url');
  if (linked?.passages?.length) {
    const scored = await reflex.rerank(question.replace(/https?:\/\/\S+/, '').trim() || 'main points', linked.passages.map(p => p.text));
    const top = linked.passages.map((p, i) => ({ ...p, s: scored[i].logit })).sort((a, b) => b.s - a.s).slice(0, 8).sort((a, b) => linked.passages.indexOf(a) - linked.passages.indexOf(b));
    evidence = evidence.filter(e => e.tool !== 'read_url').concat(top.map(p => ({ ...p, tool: 'read_url' })));
    evidence.forEach((e, i) => { e.id = i + 1; });
  }

  const sources = [];
  const addSource = s => { if (s.url && !sources.some(x => x.url === s.url)) sources.push(s); };
  for (const tool of toolResults) for (const s of tool.sources || []) addSource({ ...s, site: s.url ? siteOf(s.url) : '', host: s.url ? hostOf(s.url) : tool.title, tool: tool.id });
  for (const e of evidence) addSource({ url: e.url, title: e.title, site: e.site, host: e.host, trust: e.trust, date: e.date });
  emit({ type: 'sources', sources, evidence: evidence.map(slim) });

  const exact = standalone && toolResults[0]?.direct && (['Compute', 'Money'].includes(toolResults[0].family) || toolResults[0].exact);
  if (exact) {
    const tool = toolResults[0];
    const basis = toolResults.slice(1).filter(t => !t.booster && t.facts?.length).map(t => t.facts[0]).slice(0, 1);
    const rest = tool.body || (tool.facts.join(' ').replace(/\*\*/g, '') === tool.direct.replace(/\*\*/g, '') ? '' : tool.facts.join(' '));
    const text = tool.say != null ? [tool.say, ...basis].filter(Boolean).join('\n\n') : [tool.direct, ...basis, rest].filter(Boolean).join('\n\n');
    emit({ type: 'token', text });
    const blocks = parseBlocks(text);
    for (const b of blocks) for (const s of b.sentences || []) Object.assign(s, { status: 'supported', cites: [1] });
    return { mode: 'research', question, format: 'tool', answer: text || tool.facts[0] || '', blocks, sources, evidence: evidence.map(slim), cards, vote: null, stats: { sentences: 1, supported: 1, partial: 0, unverified: 0, removed: 0 }, tools: [{ id: tool.id, title: tool.title, ms: tool.ms, args: tool.args }], exact: true, timings: { ...timings, total: Math.round(performance.now() - t0) } };
  }

  if (!evidence.length) {
    const text = "I couldn't reach any sources for this just now — the search providers didn't answer. Try again in a moment, or rephrase the question.";
    emit({ type: 'token', text });
    return { mode: 'research', question, answer: text, blocks: parseBlocks(text), sources: [], evidence: [], cards, vote: null, stats: null, timings: { ...timings, total: Math.round(performance.now() - t0) } };
  }

  const indexPromise = indexEvidence(evidence);

  let vote = null;
  if (type !== 'any' && !standalone) {
    const tVote = performance.now();
    stage('vote');
    vote = await runVote(focus || question, evidence.filter(e => e.text.length > 20), { when: timeOf(question) });
    mark('vote', tVote);
    await checkVote(vote, focus || question, await indexPromise);
    const { clusters, ...shown } = vote;
    emit({ type: 'vote', vote: shown });
  }

  let polar = null;
  const statement = await statementPromise;
  if (statement && !standalone) {
    const tPolar = performance.now();
    polar = await polarVote(statement, await indexPromise);
    mark('polar', tPolar);
    if (polar) emit({ type: 'polar', polar: { statement: polar.statement, verdict: polar.verdict, yes: polar.yes.map(x => x.site), no: polar.no.map(x => x.site), qualified: polar.qualified.map(x => x.site) } });
  }
  const fresh = isFresh(question);
  const wants = styleOf(task.prompt);

  stage('speak', { format, evidence: evidence.length });
  const checks = new Map();
  const check = text => {
    if (!checks.has(text)) {
      const job = indexPromise.then(index => checkSentence(text, index, { question })).then(result => { emit({ type: 'claim', text, ...result }); return result; });
      checks.set(text, job);
    }
    return checks.get(text);
  };
  const checkCompleted = (draft, final = false) => {
    const blocks = parseBlocks(draft);
    blocks.forEach((block, bi) => (block.sentences || []).forEach((s, si) => {
      const last = bi === blocks.length - 1 && si === block.sentences.length - 1;
      if (!last || final || /[.!?]["”)]?\s+$/.test(draft)) check(s.text);
    }));
  };
  const write = async (messages, options = {}) => {
    let since = 0;
    return mouth.say(messages, {
      signal, maxTokens: format === 'factoid' || format === 'tool' ? 260 : 650, temperature: 0.25, ...options,
      onToken: (piece, full) => {
        emit({ type: 'token', text: piece });
        if (/[.!?\n]/.test(piece) && full.length - since > 30) { since = full.length; checkCompleted(full); }
      }
    });
  };
  const verifyBlocks = async blocks => {
    const index = await indexPromise;
    await Promise.all(blocks.flatMap(b => [
      ...(b.sentences || []).map(s => check(s.text).then(r => Object.assign(s, r))),
      ...(b.cells || []).map(c => checkCell(c, index).then(r => { Object.assign(c, r); emit({ type: 'cell', ...r }); }))
    ]));
  };
  const FACT_BUDGET = { factoid: 4, tool: 5, explain: 9, howto: 10, list: 10, compare: 12, news: 9 };
  const style = process.env.ZK_STYLE || (format === 'code' ? 'evidence' : 'facts');
  let prompt;
  if (style === 'facts') {
    const tFacts = performance.now();
    const index = await indexPromise;
    const toolFacts = evidence.filter(e => e.tool && e.tool !== 'read_url').map(e => ({ text: e.text, id: e.id }));
    const picked = await selectFacts(focus || question, index, Math.max(3, (FACT_BUDGET[format] || 8) - Math.min(toolFacts.length, 4)));
    let facts = [...toolFacts.slice(0, 6), ...picked.filter(p => !toolFacts.some(t => t.text === p.text))];
    if (vote?.settled && vote.answer) {
      const spans = await reflex.extract(focus || question, facts.map(f => f.text));
      const screened = facts.filter((f, i) => spans[i].score < 0.3 || mentions(f.text, vote) || mentions(spans[i].answer, vote));
      if (screened.length >= 2) facts = screened;
    }
    const when = timeOf(question);
    if (when && type === 'date') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const kept = facts.filter(f => { const d = dateOf(f.text); return !d || d.precision === 'year' || (when === 'next' ? d.date >= today : d.date <= today); });
      if (kept.length) facts = kept;
    }
    mark('facts', tFacts);
    emit({ type: 'facts', facts: facts.map(f => ({ text: f.text, id: f.id })) });
    if (derive) {
      const checked = [];
      const structured = await inputFacts;
      for (const [i, input] of inputs.entries()) {
        const wd = structured[i];
        const best = wd?.facts?.length ? (await reflex.rerank(input, wd.facts)).map((r, k) => ({ r, k })).sort((a, b) => b.r.logit - a.r.logit)[0] : null;
        if (best && best.r.p >= 0.5) {
          const text = `${input.replace(/\?$/, '')}: ${wd.facts[best.k]} (Wikidata)`;
          evidence.push({ id: evidence.length + 1, text: wd.facts[best.k], url: wd.sources?.[0]?.url || '', title: wd.sources?.[0]?.title || 'Wikidata', site: 'wikidata.org', host: 'www.wikidata.org', section: 'Wikidata', trust: 0.92, tool: 'wikidata', relevance: 1 });
          checked.push({ text, id: evidence.length });
          if (wd.sources?.[0]?.url && !sources.some(x => x.url === wd.sources[0].url)) sources.push({ url: wd.sources[0].url, title: wd.sources[0].title, site: 'wikidata.org', host: 'www.wikidata.org', trust: 0.92, tool: 'wikidata' });
          continue;
        }
        const v = await runVote(input, evidence.filter(e => e.text.length > 20), { when: timeOf(input) });
        if (v?.answer && v.settled) checked.push({ text: `${input.replace(/\?$/, '')}: ${v.answer} (${v.agree} of ${v.of} independent sites agree; for example "${v.alternatives[0]?.quote?.slice(0, 160)}")`, id: evidence.find(e => e.url === v.alternatives[0]?.url)?.id || 1 });
      }
      const pool = checked.length && checked.length === inputs.length ? checked : [...checked, ...facts];
      const given = pool.map(f => f.text).join(' ');
      emit({ type: 'tool', id: 'solve', title: byId.solve.title, status: 'running', args: { problem: question } });
      const solved = await runTool('solve', { problem: `FACTS: ${given}\nQUESTION: ${question}` }, { question, signal }).catch(error => ({ error }));
      const implausible = !solved.error && ((/\bold\b|\bage\b/i.test(`${solved.unit} ${question}`) && !(solved.value >= 0 && solved.value <= 125)) || !Number.isFinite(solved.value));
      const made = solved.error ? ['?'] : implausible ? ['implausible result'] : invented(solved, `${question} ${given}`);
      emit({ type: 'tool', id: 'solve', title: byId.solve.title, status: made.length ? 'failed' : 'done', ms: solved.ms, error: made.length ? (solved.error?.message || `used values not in the sources (${made.join(', ')})`) : undefined });
      if (!made.length) {
        const holds = (text, n) => new RegExp(String.raw`(^|[^\d.])${String(n).replace('.', '\\.')}([^\d]|$)`).test(text.replace(/,(?=\d{3})/g, ''));
        const used = pool.filter(f => (solved.constants || []).some(n => !SAFE_CONSTANTS.has(n) && holds(f.text, n))).slice(0, 3);
        const text = [solved.direct, ...used.map(f => `- ${f.text}`), solved.body].filter(Boolean).join('\n\n');
        emit({ type: 'reset' });
        emit({ type: 'token', text });
        if (solved.card) cards.unshift({ tool: 'solve', ...solved.card });
        const blocks = parseBlocks(text);
        for (const b of blocks) for (const s of b.sentences || []) Object.assign(s, { status: 'supported', cites: used.map(f => f.id) });
        return { mode: 'research', question, format: 'tool', answer: text || tool.facts[0] || '', blocks, sources, evidence: evidence.map(slim), cards, vote: null, stats: { sentences: blocks.length, supported: blocks.length, partial: 0, unverified: 0, removed: 0 }, tools: [{ id: 'solve', title: byId.solve.title, ms: solved.ms }], derived: true, timings: { ...timings, total: Math.round(performance.now() - t0) } };
      }
    }
    if (derive) vote = null;
    prompt = factsPrompt({ question, intent: format, facts, vote, polar, history, fresh, style: wants });
  } else prompt = researchPrompt({ question, intent: format, evidence, vote, polar, tools: [], history, fresh, style: wants });
  const snippet = format === 'code' ? await pickSnippet(question, found.snippets) : null;
  if (snippet) {
    emit({ type: 'snippet', url: snippet.url, site: snippet.site, agree: snippet.agree });
    prompt[prompt.length - 1].content += `\n\nThis code from ${snippet.site} answers it; explain in two or three sentences what it does and how to use it. Do not write any code yourself:\n\`\`\`${snippet.lang}\n${snippet.code}\n\`\`\``;
  }
  const tSpeak = performance.now();
  let draft = (await write(prompt)).text;
  if (snippet) draft = draft.replace(/```[\s\S]*?(```|$)/g, '').trim() + `\n\n\`\`\`${snippet.lang || ''}\n${snippet.code}\n\`\`\`\n\nFrom ${snippet.site}${snippet.agree ? `; ${snippet.agree} other site${snippet.agree > 1 ? 's' : ''} show${snippet.agree > 1 ? '' : 's'} the same approach` : ''}.`;
  draft = tidy(draft, question);
  mark('speak', tSpeak);

  stage('verify');
  const tVerify = performance.now();
  let blocks = parseBlocks(draft);
  await verifyBlocks(blocks);
  let result = summarize(blocks);
  mark('verify', tVerify);

  const content = result.blocks.flatMap(b => b.sentences || []).filter(s => s.status !== 'meta');
  const failed = s => s && (s.status === 'contradicted' || s.status === 'ungrounded');
  const lead = content[0];
  if (lead && polar && ((/^\W*yes\b/i.test(lead.text) && ['no', 'qualified', 'mixed'].includes(polar.verdict)) || (/^\W*no\b/i.test(lead.text) && polar.verdict === 'yes'))) lead.status = 'contradicted';
  if (lead && format === 'factoid' && vote?.settled && !mentions(content.slice(0, 2).map(s => s.text).join(' '), vote)) lead.status = 'contradicted';
  const leadCut = failed(content[0]) || content.some((s, i) => i > 0 && failed(content[i - 1]) && /^(this|that|these|it|they|he|she)\b/i.test(s.text));
  if (result.stats.sentences && (leadCut || (result.stats.removed >= 2 && result.stats.removed >= result.stats.supported + result.stats.partial))) {
    stage('repair', { removed: result.removed.length });
    emit({ type: 'reset' });
    checks.clear();
    const tRepair = performance.now();
    const strict = researchPrompt({ question, intent: format === 'explain' ? 'factoid' : format, evidence: evidence.slice(0, 6), vote, polar, tools: [], history, fresh, style: wants });
    strict[strict.length - 1].content += `\n\nImportant: an earlier draft made claims the evidence does not support (${result.removed.slice(0, 3).map(r => `"${r.text.slice(0, 80)}"`).join('; ')}). Stay strictly with what the evidence says; quote it closely.`;
    draft = tidy((await write(strict, { temperature: 0.1 })).text, question);
    blocks = parseBlocks(draft);
    await verifyBlocks(blocks);
    const second = summarize(blocks);
    second.repaired = true;
    second.firstDraftRemoved = result.removed;
    result = second;
    mark('repair', tRepair);
  }

  if (format === 'factoid' || format === 'tool' && !standalone) {
    const lead = result.blocks.flatMap(b => b.sentences || []).find(s => s.status && s.status !== 'meta');
    const voted = vote?.answer && vote.settled;
    const corroborated = (lead?.sites?.length || 0) >= 2;
    const normative = /\b(should|best|good|recommended|ideal|healthy)\b/i.test(question);
    if (lead && type !== 'any' && !normative && !voted && !corroborated && !toolResults.some(t => !t.booster)) {
      const where = lead.sites?.[0] || vote?.alternatives?.[0]?.sites?.[0];
      result.blocks.unshift({ type: 'paragraph', sentences: [{ text: `**Not confirmed:** ${where ? `only one source (${where}) says this` : 'no two sources agreed on this'}, so treat it with caution.`, status: 'meta', note: true }] });
      result.unconfirmed = true;
    }
    if (lead && polar && /^\W*(yes|no)\b/i.test(lead.text) && !['yes', 'no'].includes(polar.verdict)) {
      result.blocks.unshift({ type: 'paragraph', sentences: [{ text: '**Not confirmed:** the sources did not clearly settle this either way, so treat it with caution.', status: 'meta', note: true }] });
      result.unconfirmed = true;
    }
  }
  if (format === 'advice') for (const b of result.blocks) for (const s of b.sentences || []) {
    if ((s.status === 'supported' || s.status === 'partial') && ADVISES.test(s.text) && !/\?\s*$/.test(s.text) && !(s.sites?.length ? s.sites : (s.cites || []).map(id => evidence.find(e => e.id === id)?.site)).some(site => site && trust(site) >= 0.75)) { s.status = 'unsupported-advice'; continue; }
    if (s.status !== 'unverified' || /\d/.test(s.text) || RISKY.test(s.text)) continue;
    if (/\?\s*$/.test(s.text) || /^(you could ask yourself|ask yourself)\b/i.test(s.text) || !(ADVISES.test(s.text) || ADVISES_MORE.test(s.text))) s.status = 'meta';
    else { s.status = 'unsupported-advice'; }
  }
  const asked = new Set(words(question));
  const when = timeOf(question);
  const firstClaim = result.blocks.flatMap(b => b.sentences || []).find(s => s.status && s.status !== 'meta' && !s.note);
  const echoes = (text, share = 0.6) => { const w = words(text); return w.length > 0 && w.filter(x => asked.has(x)).length / w.length >= share; };
  const kept = [];
  const repeats = text => { const w = new Set(words(text).filter(x => x.length > 3)); return kept.some(k => { const inter = [...w].filter(x => k.has(x)).length; return inter / Math.max(1, Math.min(w.size, k.size)) >= 0.75 && w.size > 2; }); };
  const corpus = evidence.map(e => e.text).join(' ').toLowerCase();
  const specific = s => /\d/.test(s.text) || (s.text.match(/(?<!^)(?<![.!?]\s)\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) || []).some(n => !n.toLowerCase().split(' ').every(w => asked.has(w)) && !corpus.includes(n.toLowerCase()));
  for (const block of result.blocks) {
    if (block.sentences) block.sentences = block.sentences.filter(s => {
      if (s.status === 'contradicted' || s.status === 'ungrounded') return false;
      if (/\?\s*$/.test(s.text) && echoes(s.text)) return false;
      if (!s.note && (() => {
        const kw = keywords(s.text), novel = kw.filter(w => !asked.has(w));
        const names = new Set((s.text.replace(/^\S+\s*/, '').match(/\b\p{Lu}[\p{L}\p{N}'-]*/gu) || []).map(n => n.toLowerCase()));
        const adds = novel.some(w => /\d/.test(w) || names.has(w));
        return kw.length > 0 && novel.length <= 2 && !adds && (kw.length - novel.length) / kw.length >= 0.6;
      })()) return false;
      if (!s.note && (/^(my|i|i'm|i've|we|we're|we've|our)\b/i.test(s.text) || /\b(we|i) (need|have|should|must) to\b/i.test(s.text))) return false;
      if (!s.note && repeats(s.text)) return false;
      if (META_TALK.test(s.text)) return false;
      if (when && type === 'date' && !s.note) {
        const d = dateOf(s.text), today = new Date(); today.setHours(0, 0, 0, 0);
        if (d && d.precision === 'day' && (when === 'next' ? d.date < today : d.date > today)) { result.removed.push({ text: s.text, status: 'out of date' }); result.stats.removed++; return false; }
      }
      if (s.status === 'meta' && !s.note && /\d/.test(s.text) && format !== 'advice') return false;
      if (s.status === 'unverified' && RISKY.test(s.text)) { result.removed.push({ text: s.text, status: 'unsupported' }); result.stats.removed++; return false; }
      if (s.status === 'unsupported-advice') { result.removed.push({ text: s.text, status: 'unsupported advice' }); result.stats.removed++; return false; }
      if (format === 'factoid' && s.status === 'unverified' && s !== firstClaim) { result.removed.push({ text: s.text, status: 'unsupported' }); result.stats.removed++; return false; }
      if (s.status === 'unverified' && specific(s)) { result.removed.push({ text: s.text, status: 'unsupported' }); result.stats.removed++; return false; }
      kept.push(new Set(words(s.text).filter(x => x.length > 3)));
      return true;
    });
    if (block.type === 'table') for (const cell of block.cells || []) if (cell.status === 'contradicted' || cell.status === 'ungrounded') cell.removed = true;
  }
  result.blocks = result.blocks.filter(b => !b.sentences || b.sentences.length);
  const remaining = result.blocks.flatMap(b => b.sentences || []).filter(s => s.status !== 'meta');
  const left = remaining.length + result.blocks.filter(b => b.type === 'table' || b.type === 'code').length;
  const thin = left === 1 && remaining[0]?.status !== 'supported' && ['howto', 'list', 'explain', 'compare', 'news'].includes(format);
  const unsupported = format === 'factoid' && left > 0 && !remaining.some(s => s.status === 'supported') && !vote?.settled && !['yes', 'no', 'qualified'].includes(polar?.verdict) && !toolResults.some(t => !t.booster);
  if ((!left || thin || unsupported) && evidence.length) {
    const index = await indexPromise;
    const whole = f => f.text.length > 40 && /[.!?]["”)]?$/.test(f.text.trim()) && !/…|\.\.\./.test(f.text) && /^["“(]?[A-Z0-9]/.test(f.text.trim());
    const toolLines = standalone && toolResults[0]?.facts?.length ? toolResults[0].facts.flatMap(f => String(f).split(/\n+/)).filter(Boolean).slice(0, 6).map(text => ({ text, id: 1 })) : null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const timely = f => { if (!when || type !== 'date') return true; const d = dateOf(f.text); return !d || d.precision !== 'day' || (when === 'next' ? d.date >= today : d.date <= today); };
    const about = f => !vote?.answer || String(vote.answer).split(/,\s*|\s+and\s+/).some(a => f.text.toLowerCase().includes(a.toLowerCase().split(' ').pop()));
    const reputable = f => format !== 'advice' || trust(evidence.find(e => e.id === f.id)?.site || '') >= 0.75;
    const picks = toolLines || (await selectFacts(question, index, 8)).filter(f => f.relevance > 0.4 && whole(f) && timely(f) && about(f) && reputable(f)).slice(0, 3);
    if ((thin && picks.length) || unsupported) result.blocks = result.blocks.filter(b => (b.sentences || []).length && b.sentences.every(s => s.note));
    const named = !derive && vote?.answer && !vote.settled && (vote.alternatives?.[0]?.sites || []).some(s => trust(s) >= 0.8) && (format === 'factoid' || format === 'tool');
    const settledLead = derive || (format !== 'factoid' && format !== 'tool') ? null : named ? `The sources point to **${vote.answer}** (${vote.alternatives[0].sites.join(', ')}), but no second independent site confirmed it.` : vote?.settled && vote.answer ? `**${vote.answer}** — ${vote.agree} of ${vote.of} independent sites give this answer.`
      : polar && ['yes', 'no'].includes(polar.verdict) ? `**${polar.verdict === 'yes' ? 'Yes' : 'No'}** — ${(polar.verdict === 'yes' ? polar.yes : polar.no).length} independent sites ${polar.verdict === 'yes' ? 'confirm' : 'contradict'} that ${polar.statement.replace(/\.$/, '').replace(/^./, c => c.toLowerCase())}.` : null;
    if (settledLead && (picks.length || named)) result.blocks.push({ type: 'paragraph', sentences: [{ text: settledLead, status: 'supported', cites: [] }] });
    if (picks.length) {
      result.blocks.push({ type: 'paragraph', sentences: [{ text: toolLines ? `From ${toolResults[0].title.toLowerCase()}:` : settledLead ? 'What the sources say:' : "I couldn't write a confident summary, so here is what the sources say directly:", status: 'meta' }] });
      for (const f of picks) result.blocks.push({ type: 'item', sentences: [{ text: f.text, status: 'supported', cites: [f.id] }] });
      result.extractive = true;
    } else if (!thin && !(settledLead && named)) {
      result.blocks.push({ type: 'paragraph', sentences: [{ text: "I couldn't find anything reliable enough to answer this. The sources I reached didn't agree or didn't cover it; try rephrasing, or ask about a narrower part of it.", status: 'meta' }] });
      result.extractive = true;
    }
  }
  const answerText = render(result.blocks);

  learnFromVote(vote);
  flushTrust();
  return {
    mode: 'research', question, format, answer: answerText, blocks: result.blocks, removed: result.removed, firstDraftRemoved: result.firstDraftRemoved, repaired: Boolean(result.repaired), unconfirmed: Boolean(result.unconfirmed),
    stats: result.stats, sources, evidence: evidence.map(slim), cards, vote: vote ? (({ clusters, ...v }) => v)(vote) : null,
    polar: polar ? { statement: polar.statement, verdict: polar.verdict, yes: polar.yes.map(x => x.site), no: polar.no.map(x => x.site), qualified: polar.qualified.map(x => x.site) } : null,
    tools: toolResults.map(t => ({ id: t.id, title: t.title, ms: t.ms, args: t.args })), pages: found.pages, results: found.results,
    timings: { ...timings, total: Math.round(performance.now() - t0) }
  };
}

function mentions(text, vote) {
  const t = text.toLowerCase().replace(/,(?=\d{3})/g, '');
  const options = [vote.answer, ...String(vote.answer || '').split(/,\s*|\s+and\s+/)].filter(Boolean);
  return options.some(answer => {
    const parts = answer.toLowerCase().replace(/,(?=\d{3})/g, '').match(/[\p{L}\p{N}]+/gu) || [];
    const key = parts.filter(w => w.length > 2 || /\d/.test(w));
    return key.length && key.filter(w => t.includes(w)).length / key.length >= 0.5;
  });
}

const LANGS = { css: /\bcss\b|\bdiv\b|\bflex(box)?\b|\bgrid\b|\bstyle/i, html: /\bhtml\b/i, javascript: /\b(javascript|js|node|react|typescript|ts|npm)\b/i, python: /\b(python|pip|pandas|django|flask)\b/i, sql: /\b(sql|query|database|postgres|mysql|sqlite)\b/i, bash: /\b(bash|shell|terminal|linux|command line|cli)\b/i, powershell: /\bpowershell\b/i, git: /\bgit\b/i, java: /\bjava\b/i, csharp: /\bc#|\.net\b/i, go: /\bgolang\b|\bgo\b(?= (code|program|function))/i, rust: /\brust\b/i, regex: /\bregex|regular expression/i };
const looksLike = (code, lang) => ({
  css: /[.#]?[\w-]+\s*\{[^}]*:[^}]*\}|\b(display|margin|justify-content|align-items)\s*:/i, html: /<\/?[a-z][\w-]*[\s>]/i, javascript: /\b(const|let|function|=>|console\.log|import|require)\b/, python: /\b(def|import|print\(|self|elif|lambda)\b|:\s*$/m,
  sql: /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|GROUP BY|JOIN)\b/i, bash: /^\s*(\$ )?(sudo|cd|ls|grep|echo|export|apt|brew|curl|chmod|mkdir)\b/m, powershell: /\b(Get-|Set-|New-|\$env:|Write-Host)/, git: /\bgit\s+\w+/, java: /\b(public|class|static|void|System\.out)\b/,
  csharp: /\b(using System|public class|Console\.Write|var\s+\w+\s*=)/, go: /\b(func|package main|fmt\.)/, rust: /\b(fn|let mut|println!|impl)\b/, regex: /[\\^$\[\]()?*+]{3,}/
}[lang]?.test(code) ?? true);
async function pickSnippet(question, snippets) {
  if (!snippets?.length) return null;
  const lang = Object.keys(LANGS).find(l => LANGS[l].test(question));
  const pool = snippets.filter(s => (!lang || looksLike(s.code, lang)) && s.code.split('\n').length <= 40);
  if (!pool.length) return null;
  const scores = await reflex.rerank(question, pool.map(s => `${s.section}. ${s.code.slice(0, 400)}`));
  const tokens = s => new Set((s.code.toLowerCase().match(/[a-z_][\w-]{2,}/g) || []));
  const sets = pool.map(tokens);
  pool.forEach((s, i) => {
    let agreement = 0;
    const counted = new Set();
    pool.forEach((o, j) => {
      if (o.site === s.site || counted.has(o.site)) return;
      const inter = [...sets[i]].filter(t => sets[j].has(t)).length;
      const sim = inter / Math.max(1, Math.min(sets[i].size, sets[j].size));
      if (sim >= 0.4) { agreement += sim; counted.add(o.site); }
    });
    s.agree = counted.size;
    s.score = scores[i].p * (1 + agreement) * (0.5 + s.trust);
  });
  const best = pool.sort((a, b) => b.score - a.score)[0];
  return best.score > 0.05 ? best : null;
}

const slim = e => ({ id: e.id, text: e.text, url: e.url, title: e.title, site: e.site, host: e.host, section: e.section, trust: e.trust, relevance: e.relevance, tool: e.tool || null, date: e.date || null });

function tidy(text, question = '') {
  text = text.replace(/^\s*(?:#+\s*)?(?:\*\*)?[^\n.!?]{3,160}\?(?:\*\*)?\s*/, '');
  if (question && (!POLAR.test(question.trim()) || ALTERNATIVE.test(question))) text = text.replace(/^\s*(?:yes|sure|of course|absolutely|certainly)[,!.]\s*/i, '');
  return text
    .replace(/^\s*(based on (the )?(provided |given |verified )?(evidence|information|sources|research)( provided)?,?\s*)/i, '')
    .replace(/^\s*(according to the (evidence|sources|research)( provided)?,?\s*)/i, '')
    .replace(/^\s*here('s| is) (what|the answer)[^:\n]*:\s*/i, '')
    .replace(/^\s*(that('s| is) a )?(great|good|excellent|interesting|fantastic) question[!.]?\s*/i, '')
    .replace(/^\s*(\*\*)?(final )?answer(\*\*)?:(\*\*)?\s*/gim, '')
    .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, '')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}

export function render(blocks) {
  return blocks.map(b => {
    if (b.type === 'heading') return `${'#'.repeat(b.level)} ${b.text}`;
    if (b.type === 'code') return '```' + (b.lang || '') + '\n' + b.text + '```';
    if (b.type === 'table') return b.rows.join('\n');
    const text = (b.sentences || []).map(s => s.text).join(' ');
    return b.type === 'item' ? `${'  '.repeat(b.depth || 0)}${b.ordered ? '1.' : '-'} ${text}` : text;
  }).join('\n\n');
}

export async function warmUp() {
  const { warm } = await import('./tools/index.mjs');
  const t = performance.now();
  await reflex.load();
  await warm();
  return Math.round(performance.now() - t);
}
