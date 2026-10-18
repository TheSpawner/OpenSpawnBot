import { join } from 'node:path';
import { DATA, readJSON, writeJSON } from './util.mjs';

const FILE = join(DATA, 'trust.json');
const PRIORS = [
  [/(^|\.)(apnews|reuters|bbc)\.(com|co\.uk)$/, 0.88],
  [/(^|\.)wikipedia\.org$/, 0.86], [/(^|\.)wikidata\.org$/, 0.9], [/(^|\.)britannica\.com$/, 0.9],
  [/\.gov(\.[a-z]{2})?$/, 0.9], [/\.edu$/, 0.85], [/\.ac\.[a-z]{2}$/, 0.85], [/(^|\.)europa\.eu$/, 0.9], [/(^|\.)un\.org$/, 0.88],
  [/(^|\.)(who|worldbank|imf|oecd)\.org$/, 0.9], [/(^|\.)nih\.gov$|(^|\.)nature\.com$|(^|\.)science\.org$|(^|\.)arxiv\.org$/, 0.88],
  [/(^|\.)(reuters|apnews|bbc|npr|economist|ft|nytimes|washingtonpost|theguardian|bloomberg|wsj|aljazeera|cnn|cnbc|nbcnews|cbsnews|abcnews\.go|pbs|axios|politico)\.(com|co\.uk|org|net)$/, 0.84],
  [/(^|\.)(developer\.mozilla|docs\.python|learn\.microsoft|docs\.github|nodejs|react\.dev|python\.org|rust-lang|go\.dev|kernel\.org|w3\.org|whatwg\.org)/, 0.9],
  [/(^|\.)(stackoverflow|stackexchange|github)\.com$/, 0.76], [/(^|\.)(mayoclinic|clevelandclinic|webmd|healthline|nhs)\.(org|com|uk)$/, 0.84],
  [/(^|\.)(investopedia|nasa\.gov|noaa\.gov|statista|ourworldindata|macrotrends|worldometers|imdb|espn|merriam-webster|dictionary|cambridge)\./, 0.8],
  [/\.int$|\.mil$/, 0.9], [/(^|\.)(cdc|fda|nasa|noaa|usgs|census|bls|federalreserve|sec|irs|ftc)\.gov$/, 0.92],
  [/(^|\.)(ncbi\.nlm\.nih\.gov|pubmed|sciencedirect|springer|wiley|thelancet|bmj|nejm|jamanetwork|cell|pnas|plos)\b/, 0.88],
  [/(^|\.)(theverge|wired|arstechnica|techcrunch|engadget|zdnet|cnet|tomshardware|anandtech|theatlantic|newyorker|time|usatoday|latimes|independent|telegraph|thetimes|lemonde|spiegel|dw|france24|abc\.net|cbc|globalnews|smh|scmp|japantimes|thehindu|timesofindia)\.(com|co\.uk|org|net|fr|de|ca|com\.au|com\.au|in)$/, 0.8],
  [/(^|\.)(nfl|nba|mlb|nhl|fifa|uefa|olympics|premierleague|formula1|atptour|wtatennis|pgatour|espn|sports-reference|basketball-reference|pro-football-reference|baseball-reference|timeanddate|weather|metoffice|accuweather|esa|iau|ieee|iso|ietf|unicode)\.(com|org|int|gov|co\.uk)$/, 0.86],
  [/(^|\.)(psychologytoday|gottman|verywellmind|helpguide|apa|loveisrespect|relate|mind|samhsa|nami|mentalhealth)\.(com|org|org\.uk|gov)$/, 0.86],
  [/(^|\.)(investor|consumerfinance|finra|sec|ftc|treasurydirect|ssa)\.(gov|org)$|(^|\.)finra\.org$|(^|\.)moneyhelper\.org\.uk$|(^|\.)fca\.org\.uk$/, 0.9],
  [/(^|\.)(nerdwallet|bankrate|investopedia|morningstar|kiplinger|fidelity|vanguard|schwab|thebalancemoney|which|moneysavingexpert|nolo|findlaw|consumerreports)\.(com|co\.uk|org)$/, 0.82],
  [/(^|\.)reddit\.com$/, 0.5], [/(^|\.)quora\.com$/, 0.38], [/(^|\.)medium\.com$/, 0.55], [/(^|\.)(pinterest|facebook|instagram|tiktok|x|twitter|linkedin|threads)\.(com|net)$/, 0.3],
  [/(^|\.)(youtube)\.com$/, 0.45], [/(^|\.)answers\.com$|(^|\.)ask\.com$/, 0.3],
  [/(^|\.)(binance|coinbase|kraken|bybit|okx|kucoin|bitget|gemini|crypto|primexbt|changelly|bitpanda|etoro|robinhood|webull|mexc|gate|htx|bitstamp|bitfinex|coinmarketcap)\.(com|io|us)$/, 0.45],
  [/(^|\.)(alibaba|aliexpress|amazon|ebay|etsy|temu|walmart|shein|wish|made-in-china|indiamart|dhgate)\.(com|co\.uk|de|in)$/, 0.3],
  [/(^|\.)(hubpages|lemon8-app|flipboard|scribd|slideshare|wattpad|tumblr|blogspot|wordpress|weebly|wixsite|substack|vocal\.media|steemit|newsbreak|msn|yahoo)\.(com|media)$/, 0.45],
  [/(^|\.)(brainly|chegg|coursehero|studocu|ehow|reference|ranker|list25|buzzfeed)\.com$/, 0.5]
];
const DEFAULT = 0.6;
const WEIGHT = 6;

let table = readJSON(FILE, {});
let dirty = false;

export function prior(site) {
  for (const [pattern, value] of PRIORS) if (pattern.test(site)) return value;
  return DEFAULT;
}

export function trust(site) {
  const p = prior(site);
  const record = table[site];
  if (!record) return p;
  return (p * WEIGHT + record.agree) / (WEIGHT + record.agree + record.disagree);
}

export function observe(site, agreed) {
  const record = table[site] ||= { agree: 0, disagree: 0 };
  if (agreed) record.agree++; else record.disagree++;
  dirty = true;
}

export function flush() {
  if (!dirty) return;
  writeJSON(FILE, table);
  dirty = false;
}

export const snapshot = () => Object.entries(table).map(([site, r]) => ({ site, ...r, trust: trust(site), prior: prior(site) })).sort((a, b) => (b.agree + b.disagree) - (a.agree + a.disagree));
