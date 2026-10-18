import { getJSON, cached, HOUR, MINUTE, DAY } from '../util.mjs';

const LANGS = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', brazilian: 'pt-BR', japanese: 'ja',
  chinese: 'zh-CN', mandarin: 'zh-CN', cantonese: 'zh-HK', korean: 'ko', russian: 'ru', arabic: 'ar', hindi: 'hi', dutch: 'nl',
  swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', polish: 'pl', turkish: 'tr', greek: 'el', hebrew: 'he',
  vietnamese: 'vi', thai: 'th', indonesian: 'id', ukrainian: 'uk', czech: 'cs', romanian: 'ro', hungarian: 'hu', persian: 'fa',
  farsi: 'fa', swahili: 'sw', tagalog: 'tl', filipino: 'tl', malay: 'ms', bengali: 'bn', urdu: 'ur', punjabi: 'pa', tamil: 'ta',
  irish: 'ga', welsh: 'cy', catalan: 'ca', latin: 'la', croatian: 'hr', serbian: 'sr', bulgarian: 'bg', slovak: 'sk', icelandic: 'is'
};
const LANG = Object.keys(LANGS).join('|');
const name = code => Object.keys(LANGS).find(k => LANGS[k] === code)?.replace(/^./, c => c.toUpperCase()) || code;
const unquote = s => s.trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();

function readRequest(q) {
  const t = q.trim().replace(/\?+$/, '');
  const from = t.match(new RegExp(String.raw`\bfrom\s+(${LANG})\b`, 'i'))?.[1];
  const patterns = [
    new RegExp(String.raw`translate\s+(?:this|the following)?\s*(?:from\s+(?:${LANG})\s+)?(?:in)?to\s+(${LANG})\s*:\s*([\s\S]+)$`, 'i'),
    new RegExp(String.raw`how (?:do|would|can|should) (?:i|you|we|one) say\s+([\s\S]+?)\s+in\s+(${LANG})\b`, 'i'),
    new RegExp(String.raw`translate\s+([\s\S]+?)\s+(?:from\s+(?:${LANG})\s+)?(?:in)?to\s+(${LANG})\b`, 'i'),
    new RegExp(String.raw`(?:what(?:'s| is| does)|say)\s+([\s\S]+?)\s+(?:mean\s+)?in\s+(${LANG})\b`, 'i'),
    new RegExp(String.raw`what does\s+([\s\S]+?)\s+mean\b`, 'i')
  ];
  for (const [i, p] of patterns.entries()) {
    const m = t.match(p);
    if (!m) continue;
    const [text, to] = i === 0 ? [m[2], m[1]] : i === 4 ? [m[1], 'english'] : [m[1], m[2]];
    const clean = unquote(text.replace(/^(the (word|phrase|sentence)\s+)/i, ''));
    if (!clean || clean.length > 1500) return null;
    return { text: clean, to: LANGS[to.toLowerCase()], from: from ? LANGS[from.toLowerCase()] : i === 4 || LANGS[to.toLowerCase()] === 'en' ? 'Autodetect' : 'en' };
  }
  return null;
}

const memory = cached('translate', 24 * HOUR, async (text, from, to) => getJSON(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`, { timeout: 8000 }));

const SCRIPT = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/, 'zh-CN': /[\u4e00-\u9fff]/, 'zh-HK': /[\u4e00-\u9fff]/, ko: /[\uac00-\ud7af]/,
  ru: /[\u0400-\u04ff]/, uk: /[\u0400-\u04ff]/, bg: /[\u0400-\u04ff]/, sr: /[\u0400-\u04ff]/, ar: /[\u0600-\u06ff]/, fa: /[\u0600-\u06ff]/,
  ur: /[\u0600-\u06ff]/, he: /[\u0590-\u05ff]/, hi: /[\u0900-\u097f]/, bn: /[\u0980-\u09ff]/, th: /[\u0e00-\u0e7f]/, el: /[\u0370-\u03ff]/,
  ta: /[\u0b80-\u0bff]/, pa: /[\u0a00-\u0a7f]/
};
function inScript(text, to) {
  const letters = [...text].filter(c => /\p{L}/u.test(c));
  if (!letters.length) return false;
  const own = SCRIPT[to];
  const share = own ? letters.filter(c => own.test(c)).length / letters.length : letters.filter(c => /\p{Script=Latin}/u.test(c)).length / letters.length;
  return share >= 0.6;
}

const WIKI_CODE = { 'zh-CN': 'cmn', 'zh-HK': 'yue', 'pt-BR': 'pt' };
const wikitext = cached('wiktionary', 7 * DAY, async page => {
  const data = await getJSON(`https://en.wiktionary.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=${encodeURIComponent(page)}`, { timeout: 7000, headers: { 'user-agent': 'OpenSpawn Bot (local assistant)' } }).catch(() => null);
  return data?.parse?.wikitext?.['*'] || '';
});
const unlink = s => s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');
async function englishTranslations(page) {
  let text = await wikitext(page);
  const english = (text.split(/\n(?===[^=])/).find(s => /^==\s*English\s*==/.test(s.trim())) || '');
  if (!english) return '';
  const first = english.split(/\n=+\s*Translations\s*=+\s*\n/)[1] || '';
  const head = first.split(/\n=+[^=\n]+=+\s*\n/)[0];
  if (!/\{\{trans-top/.test(head) && /translation subpage|\{\{trans-see|\{\{see-translation/i.test(head)) return wikitext(`${page}/translations`);
  return head || english;
}
async function wiktionary(phrase, to) {
  const page = phrase.trim().replace(/[?!.]+$/, '');
  const code = WIKI_CODE[to] || to.split('-')[0];
  for (const candidate of [...new Set([page, page.toLowerCase()])]) {
    const text = await englishTranslations(candidate);
    const block = unlink((text.match(/\{\{trans-top[\s\S]*?\{\{trans-bottom\}\}/) || [''])[0]);
    const found = [];
    const template = new RegExp(String.raw`\{\{tt?\+?\|${code.replace('-', '\\-')}\|([^}]*)\}\}((?:\s*\{\{(?:qualifier|q|i)\|[^}]*\}\})?)`, 'g');
    for (const m of block.matchAll(template)) {
      const parts = m[1].split('|');
      const word = (parts.find(p => p.startsWith('alt='))?.slice(4) || parts[0]).trim();
      const tr = parts.find(p => p.startsWith('tr='))?.slice(3).split(',').map(s => s.trim()).find(s => /\p{Script=Latin}/u.test(s));
      const note = m[2].match(/\{\{(?:qualifier|q|i)\|([^}]*)\}\}/)?.[1]?.replace(/\|/g, ', ');
      if (word && !found.some(f => f.word === word)) found.push({ word, tr, note });
    }
    if (found.length) return { found, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(candidate.replace(/ /g, '_'))}#Translations` };
  }
  return null;
}

async function machine(text, from, to) {
  const pieces = text.length <= 450 ? [text] : text.match(/[^.!?]+[.!?]*\s*/g).reduce((acc, s) => { if (acc.length && (acc.at(-1) + s).length <= 450) acc[acc.length - 1] += s; else acc.push(s); return acc; }, []);
  const out = [];
  let detected = null;
  for (const piece of pieces.slice(0, 8)) {
    const data = await memory(piece.trim(), from, to);
    if (data.responseStatus && Number(data.responseStatus) !== 200) throw new Error(data.responseDetails || 'translation failed');
    detected ||= data.responseData?.detectedLanguage || null;
    const best = String(data.responseData?.translatedText || '').trim();
    if (!best || !inScript(best, to)) throw new Error('no usable translation');
    out.push(best);
  }
  return { translation: out.join(' '), detected };
}

const translate = {
  id: 'translate', title: 'Translator', family: 'Language', standalone: true,
  description: 'Translate words, phrases or text between languages, and say how to say something in another language',
  examples: ['how do you say thank you in Japanese', 'translate good morning into Spanish', 'what is cat in French', 'translate this to German: where is the train station', 'how do I say I love you in Korean', 'what does gracias mean', 'say happy birthday in Italian', 'translate hello from English to Russian'],
  pattern: new RegExp(String.raw`\b(translate|translation|how (do|would|can|should) (i|you|we|one) say|what does .+ mean|in (${LANG})\b)`, 'i'),
  args: { text: { type: 'string', description: 'the exact words to translate' }, to: { type: 'string', description: 'target language code, e.g. es, ja, fr' }, from: { type: 'string', description: 'source language code, usually en' } },
  required: ['text', 'to'],
  extract: readRequest,
  async run({ text, to, from = 'en' }) {
    if (!to) throw new Error('no target language');
    const short = text.split(/\s+/).length <= 6 && from === 'en' && to !== 'en';
    const dictionary = short ? await wiktionary(text, to) : null;
    if (dictionary) {
      const shown = f => `${f.word}${f.tr ? ` (${f.tr})` : ''}${f.note ? ` — ${f.note}` : ''}`;
      const [main, ...rest] = dictionary.found;
      const facts = [`"${text}" in ${name(to)} is "${main.word}"${main.tr ? `, pronounced ${main.tr}` : ''}${main.note ? ` (${main.note})` : ''}.`];
      if (rest.length) facts.push(`Other ways to say it: ${rest.slice(0, 3).map(shown).join('; ')}.`);
      return {
        facts,
        direct: `**${main.word}**${main.tr ? ` (${main.tr})` : ''}${main.note ? ` — ${main.note}` : ''}`,
        body: rest.length ? `Other ways to say it:\n${rest.slice(0, 4).map(f => `- ${shown(f)}`).join('\n')}` : '',
        exact: true,
        card: { kind: 'metric', headline: main.word.slice(0, 80), detail: `English → ${name(to)}${main.tr ? ` · ${main.tr}` : ''}` },
        sources: [{ title: `Wiktionary: ${text}`, url: dictionary.url }]
      };
    }
    const { translation, detected } = await machine(text, from, to);
    const source = detected || from;
    return {
      facts: [`"${text}" in ${name(to)} is "${translation}".`],
      direct: translation.length < 160 ? `**${translation}**` : translation,
      body: source && source !== 'Autodetect' && source !== to ? `${name(source)} → ${name(to)} (machine translation)` : 'Machine translation',
      exact: true,
      card: { kind: 'metric', headline: translation.slice(0, 80), detail: `${name(source === 'Autodetect' ? 'auto' : source)} → ${name(to)}` },
      sources: [{ title: 'MyMemory machine translation', url: 'https://mymemory.translated.net/' }]
    };
  }
};

const TOPIC_CATEGORY = [[/program|coder|coding|developer|software|computer|javascript|python|engineer|tech|it\b|sql|bug/i, 'Programming'], [/halloween|ghost|spooky|skeleton|zombie/i, 'Spooky'], [/christmas|santa|xmas/i, 'Christmas'], [/pun/i, 'Pun']];
const jokeApi = cached('jokeapi', 10 * MINUTE, async (category, contains) => getJSON(`https://v2.jokeapi.dev/joke/${category}?safe-mode${contains ? `&contains=${encodeURIComponent(contains)}` : ''}&amount=5`, { timeout: 6000 }));
const dadJoke = cached('dadjoke', 10 * MINUTE, async term => getJSON(term ? `https://icanhazdadjoke.com/search?term=${encodeURIComponent(term)}&limit=20` : 'https://icanhazdadjoke.com/', { timeout: 6000, headers: { accept: 'application/json', 'user-agent': 'OpenSpawn Bot (local assistant)' } }));
const textOf = j => j.type === 'twopart' ? `${j.setup}\n\n${j.delivery}` : j.joke;
const pickOne = list => list[Math.floor(Math.random() * list.length)];

const joke = {
  id: 'joke', title: 'Jokes', family: 'Language', standalone: true,
  description: 'A real joke, optionally about a topic: programming, puns, dad jokes, holidays',
  examples: ['tell me a joke', 'tell me a joke about programmers', 'got any dad jokes', 'make me laugh', 'tell me a pun', 'know any good computer jokes', 'tell me a funny joke about cats', 'say something funny'],
  pattern: /\b(jokes?|pun|puns|make me laugh|something funny|dad joke)\b/i,
  args: { topic: { type: 'string', description: 'what the joke should be about, or empty' } },
  required: [],
  extract: q => {
    if (!/\b(jokes?|pun|puns|make me laugh|something funny)\b/i.test(q)) return null;
    const topic = q.match(/\b(?:about|on|involving|with)\s+(?:a |an |the )?([\w -]{2,30}?)\s*[?.!]*$/i)?.[1] || (q.match(/\b(\w+)\s+jokes?\b/i)?.[1] || '').replace(/^(a|any|some|good|funny|dad|me|another)$/i, '');
    return { topic: topic.replace(/s$/, '') };
  },
  async run({ topic = '' }) {
    const category = TOPIC_CATEGORY.find(([p]) => p.test(topic))?.[1];
    const tries = [
      category ? () => jokeApi(category, '') : null,
      topic ? () => jokeApi('Any', topic) : null,
      topic ? () => dadJoke(topic).then(d => ({ jokes: (d.results || []).map(r => ({ type: 'single', joke: r.joke })) })) : null,
      () => jokeApi('Misc,Pun,Programming', ''),
      () => dadJoke('').then(d => ({ jokes: [{ type: 'single', joke: d.joke }] }))
    ].filter(Boolean);
    for (const attempt of tries) {
      try {
        const data = await attempt();
        const list = (data.jokes || (data.joke || data.setup ? [data] : [])).map(textOf).filter(Boolean);
        if (list.length) {
          const text = pickOne(list);
          return { facts: [text], direct: text, exact: true, body: '', sources: [{ title: category || topic ? 'JokeAPI / icanhazdadjoke' : 'JokeAPI', url: 'https://jokeapi.dev/' }] };
        }
      } catch {}
    }
    throw new Error('no joke found');
  }
};

export default [translate, joke];
