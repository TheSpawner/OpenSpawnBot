import { create, all } from 'mathjs';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import * as mouth from '../mouth.mjs';
import { geocode, placeFrom } from './geo.mjs';

const math = create(all, { number: 'number', precision: 14 });
const limitedEvaluate = math.evaluate;
const fmt = value => {
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('en-US') : Number(value.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 10 });
  return math.format(value, { precision: 10 });
};

const pretty = n => { const a = Math.abs(n); return a === 0 ? '0' : n.toLocaleString('en-US', a >= 1000 ? { maximumFractionDigits: 1 } : a >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 }); };
const UNIT_LABELS = { degC: '°C', degF: '°F', 'mi/h': 'mph', inch: 'in', lbm: 'lb', ml: 'mL', tablespoon: 'tbsp', teaspoon: 'tsp', hectare: 'ha', stone: 'st', 'm^2': 'm²', 'km^2': 'km²', 'ft^2': 'ft²', 'mi^2': 'mi²', 'cm^2': 'cm²', 'm^3': 'm³' };
const WORD_UNITS = { cup: 'cup', acre: 'acre', second: 'second', minute: 'minute', hour: 'hour', day: 'day', week: 'week', year: 'year' };
const unitLabel = (text, count) => String(text).trim().replace(/(\d[\d.,]*\s*)?([A-Za-z]+(?:\^[23])?(?:\/[A-Za-z]+)?)/g, (m, num, u) => { const n = num ? Number(num.replace(/,/g, '')) : count; const word = WORD_UNITS[u]; return (num || '') + (word ? (n === 1 ? word : word + 's') : UNIT_LABELS[u] ?? u); });
const WORD_OPS = [
  [/(\d+(?:\.\d+)?)\s*(?:percent|per cent|pct)\b/gi, '$1%'],
  [/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d[\d,]*(?:\.\d+)?)/gi, '($1/100)*$2'],
  [/\b(?:square root|sqrt) of\s*/gi, 'sqrt '], [/\bcube root of\s*([\d.]+)/gi, 'cbrt($1)'],
  [/\bsqrt\s+([\d.]+)/gi, 'sqrt($1)'],
  [/\bplus\b/gi, '+'], [/\bminus\b/gi, '-'], [/\b(?:times|multiplied by)\b/gi, '*'], [/\bdivided by\b/gi, '/'], [/\bover\b/gi, '/'],
  [/\bto the power of\b/gi, '^'], [/\bsquared\b/gi, '^2'], [/\bcubed\b/gi, '^3'], [/[×x](?=\s*[\d(])/g, '*'], [/÷/g, '/'],
  [/\bmod(?:ulo)?\b/gi, ' mod '], [/(\d),(\d{3})/g, '$1$2'], [/\bpi\b/gi, 'pi'], [/(\d)\s*!/g, 'factorial($1)']
];
function toExpression(text) {
  let e = String(text).toLowerCase()
    .replace(/^(?:please\s+)?(?:what(?:'s|s| is)|wats|calculate|compute|evaluate|solve|work out|how much is|tell me)\s+/, '')
    .replace(/[?=]+\s*$/, '').trim();
  for (const [pattern, replacement] of WORD_OPS) e = e.replace(pattern, replacement);
  return e.replace(/\s+/g, ' ').trim();
}
const looksMath = text => {
  const e = toExpression(text);
  return /\d/.test(e) && /^[\d\s+\-*/^().,%a-z]*$/.test(e) && /[+\-*/^%]|sqrt|cbrt|sin|cos|tan|log|factorial|mod/.test(e) && !/[a-z]{3,}/.test(e.replace(/sqrt|cbrt|sin|cos|tan|log|ln|exp|factorial|mod|pi|abs|round|floor|ceil/g, ''));
};

const calculator = {
  id: 'calculator', title: 'Calculator', family: 'Compute', standalone: true,
  description: 'Exact arithmetic, percentages, powers, roots, trigonometry and algebra expressions',
  examples: ['what is 17.5% of 2384', '345 * 12.5', 'square root of 1764', 'calculate 2^32', 'what is 15 percent of 80', '(45 + 12) / 3', 'compute 7 factorial', 'how much is 1200 divided by 7', 'sin(30 deg)', 'what is 3 to the power of 5'],
  pattern: /^[\s\d+\-*/^().,%x×÷=?]+$|\b(calculate|compute|evaluate)\b|\d\s*[+\-*/^×÷]\s*\d|\d+(\.\d+)?\s*%\s*of\b|square root|factorial|\bsqrt\b|\b(plus|minus|times|divided by|multiplied by|to the power)\b/i,
  args: { expression: { type: 'string', description: 'a mathjs expression using numbers, + - * / ^ ( ), sqrt(), sin(), log(), etc.' } },
  extract: q => looksMath(q) ? { expression: toExpression(q) } : null,
  async run({ expression }) {
    const value = limitedEvaluate(expression);
    const result = fmt(value);
    return { facts: [`${expression} = ${result}`], card: { kind: 'calc', title: 'Calculation', expression, result }, sources: [], direct: `**${result}**`, say: '' };
  }
};

const UNIT_WORDS = [[/\bdegrees? (celsius|c)\b/gi, 'degC'], [/\bdegrees? (fahrenheit|f)\b/gi, 'degF'], [/(\d)\s*°?\s*c\b/gi, '$1 degC'], [/(\d)\s*°?\s*f\b/gi, '$1 degF'],
  [/\bcelsius\b/gi, 'degC'], [/\bfahrenheit\b/gi, 'degF'], [/\bkelvin\b/gi, 'K'], [/\bmph\b/gi, 'mi/h'], [/\bkph\b|\bkm\/h\b|\bkmh\b/gi, 'km/h'],
  [/\bfeet\b|\bfoot\b/gi, 'ft'], [/\binches\b|\binch\b/gi, 'inch'], [/\bpounds?\b|\blbs?\b/gi, 'lb'], [/\bounces?\b/gi, 'oz'], [/\bstones?\b/gi, 'stone'],
  [/\bkilos?\b/gi, 'kg'], [/\bgallons?\b/gi, 'gal'], [/\bliters?\b|\blitres?\b/gi, 'L'], [/\bmilliliters?\b|\bmillilitres?\b/gi, 'mL'],
  [/\bcups?\b/gi, 'cup'], [/\btablespoons?\b|\btbsp\b/gi, 'tablespoon'], [/\bteaspoons?\b|\btsp\b/gi, 'teaspoon'],
  [/\bkilometers?\b|\bkilometres?\b/gi, 'km'], [/\bmeters?\b|\bmetres?\b/gi, 'm'], [/\bcentimeters?\b|\bcentimetres?\b/gi, 'cm'], [/\bmillimeters?\b|\bmillimetres?\b/gi, 'mm'],
  [/\bmiles?\b/gi, 'mi'], [/\byards?\b/gi, 'yd'], [/\bacres?\b/gi, 'acre'], [/\bhectares?\b/gi, 'hectare'], [/\bsquare (\w+)/gi, '$1^2'],
  [/\bgigabytes?\b/gi, 'GB'], [/\bmegabytes?\b/gi, 'MB'], [/\bterabytes?\b/gi, 'TB'], [/\bkilobytes?\b/gi, 'kB'],
  [/\bhorsepower\b|\bhp\b/gi, 'hp'], [/\bkilowatts?\b/gi, 'kW'], [/\bcalories?\b/gi, 'kcal'], [/\bjoules?\b/gi, 'J'],
  [/\bminutes?\b/gi, 'minute'], [/\bhours?\b/gi, 'hour'], [/\bseconds?\b/gi, 'second'], [/\bdays?\b/gi, 'day'], [/\bweeks?\b/gi, 'week'], [/\byears?\b/gi, 'year']];
function unitExpression(q) {
  let text = String(q).toLowerCase().replace(/^(?:please\s+)?(?:convert|what(?:'s| is)|how many|how much is|change)\s+/, '').replace(/[?]+$/, '').trim();
  let from, to;
  const direct = text.match(/^([\d.,/ ]+\s*[a-z°/ ^2]+?)\s+(?:to|in|into|as)\s+([a-z°/ ^2]+)$/i);
  const asked = text.match(/^([a-z°/ ^2]+?)\s+(?:are |is )?in\s+(?:a |an |one )?([\d.,]*\s*[a-z°/ ^2]+)$/i) || text.match(/^([a-z°/ ^2]+?)\s+(?:is|are)\s+([\d.,]+\s*[a-z°/ ^2]+)$/i);
  if (direct) [from, to] = [direct[1], direct[2]];
  else if (asked) [from, to] = [asked[2], asked[1]];
  else return null;
  if (!/\d/.test(from)) from = '1 ' + from;
  for (const [p, r] of UNIT_WORDS) { from = from.replace(p, r); to = to.replace(p, r); }
  to = to.replace(/^(a|an|one)\s+/, '').trim().replace(/^°?c$/i, 'degC').replace(/^°?f$/i, 'degF').replace(/^k$/i, 'K');
  return `${from.replace(/,/g, '').trim()} to ${to}`;
}
const units = {
  id: 'units', title: 'Unit converter', family: 'Compute', standalone: true,
  description: 'Convert between units of length, weight, temperature, volume, speed, area, data and time',
  examples: ['convert 5 km to miles', '100 fahrenheit in celsius', 'how many feet in a mile', '70 kg to pounds', '2 cups in ml', '60 mph in km/h', 'how many seconds in a day', '5 feet 10 inches in cm', '3 tablespoons to teaspoons', '1 acre in square meters'],
  pattern: /\d\s*°?\s*[FC]\b|\b(convert|how many \w+ (in|are in|is|are)|to|in)\b.*\b(km|miles?|feet|ft|inch|cm|mm|kg|lbs?|pounds?|ounces?|oz|celsius|fahrenheit|°[cf]|liters?|litres?|gallons?|cups?|mph|km\/h|acres?|hectares?|gb|mb|tb|seconds?|minutes?|hours?|tablespoons?|teaspoons?|meters?|metres?|yards?)\b/i,
  args: { expression: { type: 'string', description: 'mathjs unit conversion like "5 km to mi" or "100 degF to degC"' } },
  extract: q => { const e = unitExpression(q); return e ? { expression: e } : null; },
  async run({ expression }) {
    const fixed = expression.replace(/(\d+)\s*ft\s*(\d+)\s*inch/, '($1 ft + $2 inch)');
    const value = limitedEvaluate(fixed);
    const [from, to] = expression.split(/\s+to\s+/);
    let number = null; try { number = value.toNumber(to.trim()); } catch {}
    const result = number != null ? `${pretty(number)} ${unitLabel(to, Number(pretty(number).replace(/,/g, '')))}` : math.format(value, { precision: 6 });
    const input = unitLabel(from.replace(/[()]/g, '').replace(/\s*\+\s*/g, ' '));
    return { facts: [`${input} = ${result}`], card: { kind: 'calc', title: 'Unit conversion', expression: input, result, plain: true }, sources: [], direct: `**${result}**`, say: '' };
  }
};

const DAY_MS = 86400000;
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
const nthWeekday = (year, month, weekday, n) => { const d = new Date(year, month, 1); const offset = (weekday - d.getDay() + 7) % 7; return new Date(year, month, 1 + offset + (n - 1) * 7); };
const HOLIDAYS = {
  christmas: y => new Date(y, 11, 25), 'christmas eve': y => new Date(y, 11, 24), 'new year': y => new Date(y + (new Date().getMonth() === 0 && new Date().getDate() === 1 ? 0 : 1), 0, 1), "new year's eve": y => new Date(y, 11, 31),
  halloween: y => new Date(y, 9, 31), "valentine's day": y => new Date(y, 1, 14), valentines: y => new Date(y, 1, 14), 'independence day': y => new Date(y, 6, 4), 'july 4th': y => new Date(y, 6, 4),
  thanksgiving: y => nthWeekday(y, 10, 4, 4), easter, "mother's day": y => nthWeekday(y, 4, 0, 2), "father's day": y => nthWeekday(y, 5, 0, 3), 'labor day': y => nthWeekday(y, 8, 1, 1),
  "st patrick's day": y => new Date(y, 2, 17), 'summer': y => new Date(y, 5, 21), 'winter': y => new Date(y, 11, 21), 'spring': y => new Date(y, 2, 20), 'autumn': y => new Date(y, 8, 22), 'fall': y => new Date(y, 8, 22)
};
function parseDay(text) {
  const t = text.toLowerCase().replace(/[?.!]/g, '').trim();
  const now = new Date(); now.setHours(0, 0, 0, 0);
  for (const [name, at] of Object.entries(HOLIDAYS)) if (t.includes(name.replace(/'/g, "'")) || t.includes(name.replace(/'/g, ''))) {
    let d = at(now.getFullYear());
    if (d < now && !/\b(19|20)\d\d\b/.test(t)) d = at(now.getFullYear() + 1);
    return { date: d, label: name.replace(/\b\w/g, c => c.toUpperCase()) };
  }
  if (/\btoday\b/.test(t)) return { date: now, label: 'today' };
  if (/\btomorrow\b/.test(t)) return { date: new Date(+now + DAY_MS), label: 'tomorrow' };
  if (/\byesterday\b/.test(t)) return { date: new Date(+now - DAY_MS), label: 'yesterday' };
  const rel = t.match(/(\d+)\s+(day|week|month|year)s?\s+(from now|from today|later|ago|before today)/);
  if (rel) {
    const n = Number(rel[1]) * (/ago|before/.test(rel[3]) ? -1 : 1); const d = new Date(now);
    if (rel[2] === 'day') d.setDate(d.getDate() + n); if (rel[2] === 'week') d.setDate(d.getDate() + 7 * n); if (rel[2] === 'month') d.setMonth(d.getMonth() + n); if (rel[2] === 'year') d.setFullYear(d.getFullYear() + n);
    return { date: d, label: rel[0] };
  }
  const m = t.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/);
  if (m) {
    const raw = m[1].replace(/(\d)(st|nd|rd|th)/, '$1').replace(/\bof\s+/, '');
    let d = new Date(/\d{4}/.test(raw) ? raw : `${raw} ${now.getFullYear()}`);
    if (isNaN(d)) return null;
    if (!/\d{4}/.test(raw) && d < now && /until|till|before|left|away/.test(t)) d.setFullYear(d.getFullYear() + 1);
    return { date: d, label: m[1] };
  }
  return null;
}
const longDay = d => d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const dates = {
  id: 'dates', title: 'Date calculator', family: 'Compute', standalone: true,
  description: 'Days until or since a date or holiday, day of the week for a date, date arithmetic',
  examples: ['how many days until christmas', 'what day of the week is July 4 2027', 'what date is 90 days from now', 'how many days since January 1 2020', 'when is thanksgiving this year', 'how long until new year', 'what is the date today', 'what day is it tomorrow', 'days between march 3 2025 and june 9 2026', 'when is easter'],
  pattern: /\b(days? (until|till|since|left|between|from now)|how long until|what day (of the week )?(is|was|will)|what date|today's date|date today|when is (christmas|easter|thanksgiving|halloween|new year))/i,
  extract: q => ({ text: q }),
  async run({ text }) {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const between = text.match(/between\s+(.+?)\s+and\s+(.+)$/i);
    if (between) {
      const a = parseDay(between[1]), b = parseDay(between[2]);
      if (!a || !b) throw new Error('could not read the two dates');
      const days = Math.round(Math.abs(b.date - a.date) / DAY_MS);
      return { facts: [`There are ${days.toLocaleString()} days between ${longDay(a.date)} and ${longDay(b.date)}.`], card: { kind: 'date', headline: `${days.toLocaleString()} days`, detail: `${longDay(a.date)} → ${longDay(b.date)}` }, sources: [{ title: 'Computed from the calendar', url: '' }], direct: `**${days.toLocaleString()} days**` };
    }
    const target = parseDay(text) || { date: now, label: 'today' };
    const diff = Math.round((target.date - now) / DAY_MS);
    const facts = [`Today is ${longDay(now)}.`, `${target.label[0].toUpperCase() + target.label.slice(1)} is ${longDay(target.date)}.`];
    if (diff > 0) facts.push(`That is ${diff.toLocaleString()} day${diff === 1 ? '' : 's'} from today (${(diff / 7).toFixed(1)} weeks).`);
    if (diff < 0) facts.push(`That was ${(-diff).toLocaleString()} day${diff === -1 ? '' : 's'} ago.`);
    const headline = /since|ago/.test(text) || diff < 0 ? `${Math.abs(diff).toLocaleString()} days ago` : diff > 0 && /until|till|left|long|away|how many/.test(text) ? `${diff.toLocaleString()} days` : longDay(target.date);
    return { facts, card: { kind: 'date', headline, detail: longDay(target.date) }, sources: [{ title: 'Computed from the calendar', url: '' }], direct: `**${headline}**`, say: facts[0] };
  }
};

const ZONES = { est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York', cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago', mst: 'America/Denver', mdt: 'America/Denver', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles', gmt: 'Etc/GMT', utc: 'UTC', bst: 'Europe/London', cet: 'Europe/Paris', cest: 'Europe/Paris', ist: 'Asia/Kolkata', jst: 'Asia/Tokyo', aest: 'Australia/Sydney', kst: 'Asia/Seoul', sgt: 'Asia/Singapore', hkt: 'Asia/Hong_Kong', eet: 'Europe/Athens', msk: 'Europe/Moscow', wat: 'Africa/Lagos' };
const zoneTime = (zone, date = new Date()) => date.toLocaleString('en-US', { timeZone: zone, weekday: 'long', hour: 'numeric', minute: '2-digit', month: 'long', day: 'numeric' });
function offsetMinutes(zone, date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return (Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute) - Math.floor(date / 60000) * 60000) / 60000;
}
async function zoneFor(name) {
  const key = name.trim().toLowerCase();
  if (ZONES[key]) return { zone: ZONES[key], label: name.toUpperCase() };
  const place = await geocode(name);
  if (!place) throw new Error(`no place called "${name}"`);
  return { zone: place.timezone, label: place.label };
}
const clock = {
  id: 'clock', title: 'World clock', family: 'Compute', standalone: true,
  description: 'Current local time in any city or country, and converting a time between time zones',
  examples: ['what time is it in Tokyo', 'current time in London', 'time in New York right now', 'what is 3pm EST in Tokyo time', 'convert 9am PST to London time', 'what time is it', 'local time in Sydney', 'when it is noon in Paris what time is it in Chicago'],
  pattern: /\b(what time is it|current time|local time|time (is it )?in|time zone|timezone)\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\s+\w+\s+(in|to)\b/i,
  required: [], args: { place: { type: 'string', description: 'city or country whose time is asked, or empty for here' }, convertTime: { type: 'string', description: 'a time to convert like "3pm", or empty' }, fromZone: { type: 'string', description: 'zone or city the time is in, or empty' } },
  extract(q) {
    const conv = q.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(?:in\s+)?([a-z][a-z ]*?)\s+(?:to|in|into)\s+([a-z][a-z ,]*?)(?:\s+time)?\??$/i);
    if (conv && /\d/.test(conv[1])) return { convertTime: conv[1], fromZone: conv[2], place: conv[3] };
    const place = placeFrom(q, ['clock', 'what', 'zone', 'timezone']);
    return { place: place || '' };
  },
  async run({ place, convertTime, fromZone }) {
    if (convertTime && fromZone) {
      const from = await zoneFor(fromZone), to = await zoneFor(place);
      const m = convertTime.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      let h = Number(m[1]) % 12 + (/pm/i.test(m[3] || '') ? 12 : 0); if (!m[3] && Number(m[1]) >= 12) h = Number(m[1]);
      const now = new Date();
      const guess = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, Number(m[2] || 0)));
      const utc = new Date(+guess - offsetMinutes(from.zone, guess) * 60000);
      const result = utc.toLocaleString('en-US', { timeZone: to.zone, hour: 'numeric', minute: '2-digit', weekday: 'short' });
      return { facts: [`${convertTime} in ${from.label} is ${result} in ${to.label}.`], card: { kind: 'clock', headline: result, detail: `${convertTime} ${from.label} → ${to.label}` }, sources: [{ title: 'IANA time zone database', url: 'https://www.iana.org/time-zones' }], direct: `**${result}**` };
    }
    const target = place ? await zoneFor(place) : { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, label: 'your location' };
    const time = zoneTime(target.zone);
    const offset = offsetMinutes(target.zone, new Date());
    const utcLabel = `UTC${offset >= 0 ? '+' : '-'}${Math.floor(Math.abs(offset) / 60)}${Math.abs(offset) % 60 ? ':' + String(Math.abs(offset) % 60).padStart(2, '0') : ''}`;
    return { facts: [`The local time in ${target.label} is ${time} (${target.zone}, ${utcLabel}).`], card: { kind: 'clock', headline: new Date().toLocaleTimeString('en-US', { timeZone: target.zone, hour: 'numeric', minute: '2-digit' }), detail: `${target.label} · ${new Date().toLocaleDateString('en-US', { timeZone: target.zone, weekday: 'long', month: 'long', day: 'numeric' })} · ${utcLabel}` }, sources: [{ title: 'IANA time zone database', url: 'https://www.iana.org/time-zones' }], direct: `**${time}**` };
  }
};

const random = {
  id: 'random', title: 'Random', family: 'Compute', standalone: true,
  description: 'Roll dice, flip a coin, pick a random number or choose randomly from options',
  examples: ['roll a die', 'flip a coin', 'pick a random number between 1 and 100', 'roll 2d6', 'choose between pizza, sushi and tacos', 'heads or tails', 'random number from 1 to 10'],
  pattern: /\b(roll (a |an |\d+ )?(die|dice|d\d+)|\d+d\d+|flip a coin|heads or tails|random number|pick (one|a random)|choose (randomly|between|one of))\b/i,
  extract: q => ({ text: q }),
  async run({ text }) {
    let headline, facts;
    const dice = text.match(/(\d+)?\s*d(\d+)/i);
    const range = text.match(/(-?\d+)\s*(?:and|to|-)\s*(-?\d+)/);
    const options = text.match(/(?:between|from|of)\s+(.+)$/i)?.[1]?.split(/\s*,\s*|\s+or\s+|\s+and\s+/).map(s => s.replace(/[?.]$/, '').trim()).filter(Boolean);
    if (/coin|heads|tails/i.test(text)) { headline = randomInt(2) ? 'Heads' : 'Tails'; facts = [`The coin landed on ${headline}.`]; }
    else if (dice || /\bdie\b|\bdice\b/i.test(text)) {
      const n = Math.min(Number(dice?.[1] || 1), 50), sides = Number(dice?.[2] || 6);
      const rolls = Array.from({ length: n }, () => randomInt(1, sides + 1));
      headline = rolls.length > 1 ? `${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b)}` : String(rolls[0]);
      facts = [`Rolled ${n}d${sides}: ${headline}.`];
    } else if (range) { const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y); headline = String(randomInt(a, b + 1)); facts = [`Random number between ${a} and ${b}: ${headline}.`]; }
    else if (options?.length > 1) { headline = options[randomInt(options.length)]; facts = [`Picked at random from ${options.join(', ')}: ${headline}.`]; }
    else { headline = String(randomInt(1, 101)); facts = [`Random number between 1 and 100: ${headline}.`]; }
    return { facts, card: { kind: 'big', headline, detail: 'cryptographically random' }, sources: [{ title: 'node:crypto randomInt', url: '' }], direct: `**${headline}**` };
  }
};

const password = {
  id: 'password', title: 'Password generator', family: 'Compute', standalone: true,
  description: 'Generate a strong random password, passphrase or UUID',
  examples: ['generate a password', 'make me a strong 20 character password', 'create a random uuid', 'give me a secure passphrase', 'random password with symbols'],
  pattern: /\b(generate|create|make|give me)\b.*\b(password|passphrase|uuid|guid)\b/i,
  extract: q => ({ text: q }),
  async run({ text }) {
    if (/uuid|guid/i.test(text)) { const id = randomUUID(); return { facts: [`UUID: ${id}`], card: { kind: 'big', headline: id, detail: 'UUID v4', mono: true }, sources: [], direct: '`' + id + '`' }; }
    const length = Math.min(Math.max(Number(text.match(/(\d+)\s*(?:char|letter|digit|-char)/i)?.[1] || 20), 8), 128);
    const sets = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' + (/no symbols|without symbols|alphanumeric/i.test(text) ? '' : '!@#$%^&*-_=+?');
    const pw = Array.from({ length }, () => sets[randomInt(sets.length)]).join('');
    const bits = Math.round(length * Math.log2(sets.length));
    return { facts: [`Generated a ${length}-character password with about ${bits} bits of entropy.`], card: { kind: 'big', headline: pw, detail: `${length} characters · ~${bits} bits of entropy · generated locally`, mono: true }, sources: [], direct: '`' + pw + '`' };
  }
};

const encode = {
  id: 'encode', title: 'Encode & hash', family: 'Compute', standalone: true,
  description: 'Hash text (md5, sha1, sha256), base64 encode or decode, URL encode, count words and characters',
  examples: ['sha256 of hello world', 'base64 encode "hello"', 'decode this base64: aGVsbG8=', 'md5 hash of password123', 'url encode a b&c', 'how many characters in "the quick brown fox"', 'count the words in this text'],
  pattern: /\b(sha-?1|sha-?256|sha-?512|md5|base64|url ?encode|url ?decode|hash of|how many (characters|words|letters) (are )?in|count the (words|characters))\b/i,
  extract: q => ({ text: q }),
  async run({ text }) {
    const payload = (text.match(/["“'`](.+)["”'`]\s*\??$/s)?.[1] ?? text.split(/:\s*|\bof\s+|\bencode\s+|\bdecode\s+|\bin\s+/i).at(-1)).trim();
    let label, result;
    const algo = text.match(/sha-?(1|256|512)|md5/i)?.[0]?.toLowerCase().replace('-', '');
    if (algo) { label = algo.toUpperCase(); result = createHash(algo).update(payload).digest('hex'); }
    else if (/base64/i.test(text) && /decode/i.test(text)) { label = 'Base64 decoded'; result = Buffer.from(payload, 'base64').toString('utf8'); }
    else if (/base64/i.test(text)) { label = 'Base64'; result = Buffer.from(payload).toString('base64'); }
    else if (/url ?decode/i.test(text)) { label = 'URL decoded'; result = decodeURIComponent(payload); }
    else if (/url ?encode/i.test(text)) { label = 'URL encoded'; result = encodeURIComponent(payload); }
    else { label = 'Count'; result = `${payload.length} characters, ${(payload.match(/\S+/g) || []).length} words`; }
    return { facts: [`${label} of "${payload}": ${result}`], card: { kind: 'big', headline: result, detail: `${label} of “${payload.slice(0, 60)}”`, mono: label !== 'Count' }, sources: [], direct: label === 'Count' ? `**${result}**` : '`' + result + '`' };
  }
};

const color = {
  id: 'color', title: 'Colour converter', family: 'Compute', standalone: true,
  description: 'Convert colours between hex, RGB and HSL',
  examples: ['convert #ff8800 to rgb', 'rgb(64, 123, 145) to hex', 'what is #407b91 in hsl', 'hex for rgb 255 0 0'],
  pattern: /#[0-9a-f]{3,6}\b|\brgb\s*\(|\bhsl\s*\(|\b(hex|rgb|hsl) (code|value|for|to|of)\b/i,
  extract: q => ({ text: q }),
  async run({ text }) {
    let r, g, b;
    const hex = text.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
    if (hex) { const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1]; [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
    else { const nums = text.match(/\d{1,3}/g)?.map(Number); if (!nums || nums.length < 3) throw new Error('no colour found'); [r, g, b] = nums; }
    const toHex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    const [rn, gn, bn] = [r, g, b].map(v => v / 255), max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4; h *= 60; }
    const hsl = `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
    return { facts: [`${toHex} = rgb(${r}, ${g}, ${b}) = ${hsl}`], card: { kind: 'color', hex: toHex, rgb: `rgb(${r}, ${g}, ${b})`, hsl }, sources: [], direct: `**${toHex}** · rgb(${r}, ${g}, ${b}) · ${hsl}` };
  }
};

const code = {
  id: 'run_code', title: 'Run JavaScript', family: 'Compute', standalone: true,
  description: 'Run a JavaScript snippet in a sandbox and report the output',
  examples: ['run this javascript: [1,2,3].map(x => x * 2)', 'execute this code: console.log("hi")', 'evaluate this js: Array.from({length:5},(_, i)=>i*i)', 'what does this javascript print'],
  pattern: /\b(run|execute|evaluate) (this|the following|my)? ?(js|javascript|code|snippet)\b|```(js|javascript)/i,
  extract: q => { const m = q.match(/```(?:js|javascript)?\s*([\s\S]+?)```/) || q.match(/(?:code|javascript|js|snippet)\s*:?\s*([\s\S]+)$/i); return m ? { source: m[1].trim() } : null; },
  required: ['source'], args: { source: { type: 'string', description: 'the JavaScript source code to run' } },
  async run({ source }) {
    const logs = [];
    const sandbox = { console: { log: (...a) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) }, Math, JSON, Array, Object, String, Number, Date };
    let value;
    try { value = vm.runInNewContext(source, sandbox, { timeout: 1000 }); } catch (error) { logs.push('Error: ' + error.message); }
    const output = [...logs, value !== undefined ? '→ ' + (typeof value === 'string' ? value : JSON.stringify(value)) : ''].filter(Boolean).join('\n');
    return { facts: [`Running the code printed: ${output || '(nothing)'}`], card: { kind: 'code', source, output }, sources: [{ title: 'Node.js vm sandbox (1 s limit)', url: '' }], direct: '```\n' + (output || '(no output)') + '\n```' };
  }
};

const SOLVE_EXAMPLES = [
  ['If I save $200 a month for 5 years at 5% interest, how much will I have?', { program: 'const deposit = 200, rate = 0.05 / 12, months = 5 * 12;\nreturn deposit * ((Math.pow(1 + rate, months) - 1) / rate);', unit: 'dollars', explanation: 'Future value of a monthly deposit with monthly compounding.' }],
  ["What's a 20% tip on $45?", { program: 'return 45 * 0.20;', unit: 'dollars', explanation: '20% of the bill.' }],
  ['How many months to pay off $5,000 at $300 a month with 12% APR?', { program: 'let balance = 5000, months = 0;\nconst rate = 0.12 / 12;\nwhile (balance > 0 && months < 1200) { balance = balance * (1 + rate) - 300; months++; }\nreturn months;', unit: 'months', explanation: 'Interest is added each month, then the payment is taken off, until the balance is gone.' }],
  ['If I drive 250 miles at 60 mph, how long does it take?', { program: 'return 250 / 60;', unit: 'hours', explanation: 'Time is distance divided by speed.' }],
  ['FACTS: Ethereum (ETH) is trading at 2,512.40 USD, down 0.8% in the last 24 hours.\nQUESTION: how much is $50 in ethereum', { program: 'const price = 2512.40;\nreturn 50 / price;', unit: 'ETH', explanation: '$50 divided by the price of one ETH (2,512.40 USD).' }],
  ['FACTS: Apple Inc. (AAPL) is trading at 231.15 USD.\nQUESTION: what are 12 shares of apple worth', { program: 'const price = 231.15;\nreturn 12 * price;', unit: 'dollars', explanation: '12 shares at 231.15 USD each.' }],
  ['FACTS: Bitcoin (BTC) is trading at 64,210 USD.\nQUESTION: how many bitcoin can I buy with 250 dollars', { program: 'const price = 64210;\nreturn 250 / price;', unit: 'BTC', explanation: '250 dollars divided by the price of one bitcoin (64,210 USD).' }],
  ['FACTS: Marie Curie was born on 7 November 1867. She received the Nobel Prize in Chemistry on 10 December 1911.\nQUESTION: how old was Marie Curie when she won the chemistry Nobel', { program: 'const born = new Date("1867-11-07"), event = new Date("1911-12-10");\nlet age = event.getFullYear() - born.getFullYear();\nif (event.getMonth() < born.getMonth() || (event.getMonth() === born.getMonth() && event.getDate() < born.getDate())) age--;\nreturn age;', unit: 'years old', explanation: 'From her birth on 7 November 1867 to the prize on 10 December 1911.' }]
];
const usd = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cash = v => Number.isInteger(v) ? "$" + v.toLocaleString("en-US") : usd(v);
const PER_YEAR = { day: 365, week: 52, fortnight: 26, month: 12, quarter: 4, year: 1, annum: 1 };
function formula(problem) {
  const q = problem.split(/QUESTION:/i).pop().toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
  const pct = q.match(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/)?.[1];
  const span = q.match(/(\d+(?:\.\d+)?)\s*(years?|yrs?|months?)\b/);
  const years = span ? Number(span[1]) / (/^m/.test(span[2]) ? 12 : 1) : null;
  const done = (value, explanation, program, stated) => ({ value, unit: 'dollars', program, constants: stated.map(Number), facts: [`${explanation} Result: ${usd(value)}.`], card: { kind: 'calc', title: 'Worked out', expression: explanation, result: usd(value), plain: true }, sources: [{ title: 'Standard formula', url: '' }], direct: `**${usd(value)}**`, say: '' });
  const deposit = q.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:dollars?\s*)?(?:a|per|each|every)\s+(day|week|fortnight|month|quarter|year)\b/);
  if (deposit && pct && years && /\b(invest|save|saving|put|deposit|contribute|add|set aside)\w*\b/.test(q)) {
    const k = PER_YEAR[deposit[2]], i = Number(pct) / 100 / k, n = Math.round(years * k), p = Number(deposit[1]);
    const value = i ? p * ((Math.pow(1 + i, n) - 1) / i) : p * n;
    return done(value, `${cash(p)} every ${deposit[2]} for ${n} ${deposit[2]}s at ${pct}% a year, growing with each deposit. You put in ${cash(p * n)}.`, `p * ((1 + r/${k})^${n} - 1) / (r/${k})`, [deposit[1], pct, span[1]]);
  }
  const lump = q.match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars|usd)\b/);
  if (lump && pct && years && !deposit && /\b(invest|save|put|deposit|grow|worth|compound|interest|become|turn into|end up)\w*\b/.test(q)) {
    const k = /\bdaily\b/.test(q) ? 365 : /\bmonthly\b/.test(q) ? 12 : /\bquarterly\b/.test(q) ? 4 : 1, p = Number(lump[1] || lump[2]);
    const value = p * Math.pow(1 + Number(pct) / 100 / k, years * k);
    return done(value, `${cash(p)} left for ${span[1]} ${span[2]} at ${pct}% a year, compounded ${{ 365: 'daily', 12: 'monthly', 4: 'quarterly', 1: 'yearly' }[k]}.`, `p * (1 + r/${k})^(${k} * years)`, [lump[1] || lump[2], pct, span[1]]);
  }
  const bill = q.match(/(?:on|of|for)\s+(?:a\s+)?\$\s*(\d+(?:\.\d+)?)|\$\s*(\d+(?:\.\d+)?)\s+(?:bill|dinner|meal|check|tab)/);
  if (/\btip\b/.test(q) && pct && bill) {
    const amount = Number(bill[1] || bill[2]), tip = amount * Number(pct) / 100, people = Number(q.match(/(?:between|among|by|with)\s+(\d+)\s*(?:people|persons|friends|of us|ways)/)?.[1] || 1);
    if (people > 1) return done((amount + tip) / people, `${cash(amount)} plus a ${pct}% tip (${usd(tip)}), split ${people} ways.`, `(bill + bill * tip) / people`, [bill[1] || bill[2], pct, String(people)]);
    return done(tip, `${pct}% of ${cash(amount)}. With the tip the total is ${usd(amount + tip)}.`, `bill * tip`, [bill[1] || bill[2], pct]);
  }
  const off = q.match(/(\d+(?:\.\d+)?)\s*%\s*off\s+(?:of\s+)?\$?\s*(\d+(?:\.\d+)?)/);
  if (off) { const price = Number(off[2]), cut = price * Number(off[1]) / 100; return done(price - cut, `${off[1]}% off ${cash(price)} saves ${usd(cut)}.`, `price * (1 - discount)`, [off[2], off[1]]); }
  return null;
}
const UNSAFE = /\b(require|import|process|globalThis|global|constructor|prototype|Function|eval|setTimeout|setInterval|fetch|XMLHttpRequest|Buffer|__proto__)\b/;
const solve = {
  id: 'solve', title: 'Word-problem solver', family: 'Compute', standalone: true,
  description: 'Work out maths questions written in words: savings and interest, loans and payments, tips and splitting bills, discounts, speed, time and distance, rates and averages',
  examples: ['if I save $200 a month for 5 years at 5% interest how much will I have', "what's a 15% tip on $84", 'how long will it take to pay off a 5000 dollar loan at 300 a month', 'split a $120 dinner between 3 people with a 20% tip', 'how much is 30% off $89.99', 'if I drive 300 miles at 65 mph how long will it take', 'what will 10000 dollars be worth after 10 years at 7% compound interest', 'how many hours are in 3 weeks'],
  pattern: /\b(if i (save|invest|put|borrow|pay|deposit|spend|drive|run|walk|earn|make)|how (much|long|many) (will|would|does|do|is|are|to)|tip on|split|per (month|week|year|hour)|interest|% off|discount|compound|mortgage|loan|apr|savings|average of|mph|km\/h)\b[^?]*\d/i,
  args: { problem: { type: 'string', description: 'the question, in plain words' } },
  required: ['problem'],
  extract: q => /\d/.test(q) ? { problem: q } : null,
  async run({ problem }, ctx = {}) {
    const known = formula(problem);
    if (known) return known;
    const messages = [
      { role: 'system', content: 'Turn the word problem into a short JavaScript function body that computes the answer with plain arithmetic, Math and Date, and ends with return. Declare every variable with const or let before using it. Take every number from the question or the FACTS; never make one up. Never round the result: return the exact value. Write dates as new Date("YYYY-MM-DD") strings, never new Date(year, month, day). Give the unit of the result and a one-sentence explanation that names the values used. Output JSON.' },
      ...SOLVE_EXAMPLES.flatMap(([q, a]) => [{ role: 'user', content: q }, { role: 'assistant', content: JSON.stringify(a) }]),
      { role: 'user', content: problem }
    ];
    let plan = null, value = null, lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      plan = await mouth.json(messages, { type: 'object', properties: { program: { type: 'string' }, unit: { type: 'string' }, explanation: { type: 'string' } }, required: ['program', 'unit', 'explanation'] }, { maxTokens: 300, signal: ctx.signal, temperature: attempt ? 0.3 : 0.1 });
      if (!plan?.program || UNSAFE.test(plan.program)) { lastError = 'the program used something that is not allowed; use only arithmetic and Math'; }
      else if (/new Date\(\s*\d{3,4}\s*,/.test(plan.program)) { lastError = "write every date as new Date('YYYY-MM-DD'), not new Date(year, month, day)"; }
      else {
        try {
          const sandbox = vm.createContext({ Math, Number, Array, Date }, { codeGeneration: { strings: false, wasm: false } });
          value = vm.runInContext(`(() => { ${plan.program} })()`, sandbox, { timeout: 500 });
          if (typeof value === 'number' && Number.isFinite(value)) break;
          lastError = `it returned ${String(value)} instead of a number`;
        } catch (error) { lastError = error.message; }
      }
      messages.push({ role: 'assistant', content: JSON.stringify(plan || {}) }, { role: 'user', content: `That program failed: ${lastError}. Fix it and output the corrected JSON.` });
      value = null;
    }
    if (value === null) throw new Error(`could not work that out (${lastError})`);
    const asked = problem.split(/QUESTION:/i).pop();
    const money = /^(\$|usd|us ?dollars?|dollars?)$/i.test(plan.unit.trim()) || (/\b(cost|costs|price|pay|spend|worth|budget|bill|total)\b/i.test(asked) && /price|cost|rate|fee/i.test(plan.program) && !/^(sol|btc|eth|shares?|coins?|tokens?|units?|years?|months?|days?|hours?|minutes?)\b/i.test(plan.unit.trim()));
    const digits = Math.abs(value) < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 2 };
    const shown = money ? '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : `${value.toLocaleString('en-US', digits)} ${plan.unit}`.trim();
    const constants = [...new Set((plan.program.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) || []).map(Number))];
    return {
      constants,
      program: plan.program,
      value,
      unit: plan.unit,
      facts: [`${plan.explanation} Result: ${shown}.`],
      body: `${plan.explanation}\n\n\`\`\`js\n${plan.program}\n\`\`\``,
      card: { kind: 'calc', title: 'Worked out', expression: plan.explanation, result: shown, plain: true },
      sources: [{ title: 'Worked out in a sandbox (program shown)', url: '' }],
      direct: `**${shown}**`, say: ''
    };
  }
};

export default [calculator, units, dates, clock, random, password, encode, color, code, solve];
export { toExpression, looksMath, unitExpression, parseDay };
