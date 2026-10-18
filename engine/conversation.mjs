import * as mouth from './mouth.mjs';
import * as reflex from './reflex.mjs';
import { sentences, keywords } from './util.mjs';

const ABOUT_THE_ANSWER = /^(summari[sz]e|shorten|simplify|rephrase|reword|rewrite|translate|explain (that|this|it|them|those|more|again|the|why)|elaborate|expand|tell me more|go on|continue|more detail|in (simpler|plain|other) words|make (it|that|this) (shorter|longer|simpler|clearer|more|less|formal|casual|funnier)|turn (it|that|this) into|put (it|that|this) (in|into|as)|format (it|that|this)|list (them|those|these)|sort (them|those|these)|why\??$|how so\??$|what do you mean|which (one|of (them|those|these))|the (first|second|third|last|other) one|can you (shorten|summari[sz]e|simplify|explain|translate))\b/i;
const REACHES_BACK = /\b(that|this|it|its|those|these|them|they|their|he|she|him|her|his|hers|the (above|list|last|first|second|third|previous|other|same)|one of (them|those)|which one|either|both|neither|instead|there|then|also|else|too)\b|^(and|or|but|so|what about|how about|what if|why|which|ok(ay)?|then)\b/i;

export async function classify(message, history) {
  if (!history.length) return { kind: 'standalone' };
  const last = history.at(-1);
  const text = message.trim();
  if (ABOUT_THE_ANSWER.test(text)) return { kind: 'context', why: 'asks about the last answer' };
  const reaches = REACHES_BACK.test(text) || text.split(/\s+/).length <= 6;
  if (!reaches) return { kind: 'standalone' };
  const units = sentences(String(last.answer || '').replace(/\n+/g, '. ')).filter(s => s.length > 12).slice(0, 40);
  if (units.length) {
    const scores = await reflex.rerank(text, units);
    const best = Math.max(...scores.map(s => s.logit));
    if (best > 3 && /\b(those|these|them|that|the (above|list|first|second|third|last))\b|^which\b/i.test(text)) return { kind: 'context', why: 'the last answer already contains it', score: best };
  }
  return { kind: 'rewrite' };
}

const essential = message => keywords(message).filter(w => w.length > 2 && !/^(what|about|how|which|one|cheaper|better|safer|option|right|now|price|that|this|those|these|them|they|instead|else|more|less|really|actually|also|then|okay)$/.test(w));

const EXAMPLES = [
  ['Who is the CEO of Tesla?', 'Elon Musk is the CEO of Tesla.', 'how old is he?', 'How old is Elon Musk?'],
  ['Explain how solar panels work', 'Solar panels turn sunlight into electricity using photovoltaic cells.', 'what about wind turbines?', 'Explain how wind turbines work'],
  ['What is the weather in Paris?', 'It is 14°C and cloudy in Paris.', 'and in London?', 'What is the weather in London?'],
  ['I have $100. Should I put it into Bitcoin?', 'Bitcoin is volatile; only invest what you can afford to lose.', "what's the price right now?", 'What is the current price of Bitcoin?'],
  ['Explain how heat pumps work', 'A heat pump moves heat instead of making it.', 'which one is cheaper to run, a heat pump or a gas boiler?', 'Which is cheaper to run, a heat pump or a gas boiler?'],
  ['Should I buy a used Honda Civic?', 'A used Civic is reliable and cheap to run.', 'is there a more reliable option?', 'Is there a more reliable car than a used Honda Civic?'],
  ['Is Python good for building mobile games?', 'Python is rarely used for mobile games.', 'what would be better?', 'What would be better than Python for building mobile games?']
];

const GENERIC = /^(what|price|current|currently|right|now|today|put|should|have|has|get|good|best|better|option|options|safer|cheaper|way|ways|thing|things|much|many|really|into|about|there|people|someone|something|anything|would|could|does|make|need|want|like)$/i;
function topicOf(history) {
  const recent = history.slice(-2).map(t => String(t.question || ''));
  const names = recent.flatMap(q => (q.replace(/^\s*\S+/, '').match(/\b\p{Lu}[\p{L}\p{N}'-]*(?:\s+\p{Lu}[\p{L}\p{N}'-]*)*/gu) || [])).filter(n => !/^(I|What|Which|Who|How|When|Where|Why|Should|Is|Are|Can|Do|Does)$/.test(n));
  const words = recent.flatMap(q => keywords(q)).filter(w => w.length > 2 && !GENERIC.test(w));
  return { names: [...new Set(names)], words: [...new Set(words)] };
}
const COMPARATIVE = /\b(safer|cheaper|better|worse|faster|slower|easier|harder|healthier|stronger|bigger|smaller|more \w+|less \w+)\b/i;

export async function rewrite(message, history, signal) {
  const last = history.at(-1);
  const earlier = history.length > 1 ? `Earlier question: ${history.at(-2).question}\n` : '';
  const ask = async must => mouth.json([
    { role: 'system', content: 'Rewrite the follow-up as one complete question that makes sense with no conversation around it. Keep every subject the follow-up names, and fill in only what it leaves out (who "he" is, what "it" is, what topic "what about X" continues). Output JSON.' },
    ...EXAMPLES.flatMap(([q, a, f, s]) => [{ role: 'user', content: `Previous question: ${q}\nPrevious answer: ${a}\nFollow-up: ${f}` }, { role: 'assistant', content: JSON.stringify({ standalone: s }) }]),
    { role: 'user', content: `${earlier}Previous question: ${last.question}\nPrevious answer: ${String(last.answer || '').slice(0, 600)}\nFollow-up: ${message}${must ? `\n(The rewritten question must contain: ${must.join(', ')})` : ''}` }
  ], { type: 'object', properties: { standalone: { type: 'string' } }, required: ['standalone'] }, { maxTokens: 90, signal }).catch(() => null);

  const need = essential(message);
  const keeps = text => need.every(w => text.toLowerCase().includes(w.slice(0, Math.max(4, w.length - 2))));
  const topic = topicOf(history);
  const subject = topic.names[0] || topic.words[0];
  const mentioned = [...topic.names, ...topic.words].filter(w => message.toLowerCase().includes(w.toLowerCase()));
  const resolves = text => !subject || mentioned.length > 0 || [...topic.names, ...topic.words].some(w => text.toLowerCase().includes(w.toLowerCase()));
  let out = (await ask())?.standalone?.trim();
  if (out && (!keeps(out) || !resolves(out))) out = (await ask([...need, ...(resolves(out) ? [] : [subject])]))?.standalone?.trim();
  if (!out || !keeps(out) || !resolves(out)) {
    const base = message.trim().replace(/[?.!]+$/, '');
    out = subject && COMPARATIVE.test(base) && !/\bthan\b/i.test(base) ? `${base.replace(COMPARATIVE, m => `${m}`)} than ${subject}?`.replace(/(\b(?:option|choice|alternative|way|investment|one)\b)( than )/i, '$1$2')
      : subject ? `${base} (${[subject, ...topic.words.filter(w => w.toLowerCase() !== subject.toLowerCase()).slice(0, 3)].join(' ')})?`
      : `${base} (about: ${last.question.replace(/[?.!]+$/, '')})`;
  }
  return out;
}

export function contextPrompt(message, history) {
  const turns = history.slice(-4).flatMap(t => [{ role: 'user', content: t.question }, { role: 'assistant', content: String(t.answer || '').slice(0, 4000) }]);
  return [
    { role: 'system', content: 'You continue a conversation. The user\'s new message is about what was already said. Answer it using only the conversation above: summarise, shorten, pick out, compare, translate, explain or reformat what is there. If the conversation does not contain what is needed, say what is missing in one sentence. Do not add new facts.' },
    ...turns,
    { role: 'user', content: message }
  ];
}
