import { getJSON, cached, MINUTE, HOUR } from '../util.mjs';

const CURRENCY_NAMES = {
  dollar: 'USD', dollars: 'USD', usd: 'USD', bucks: 'USD', euro: 'EUR', euros: 'EUR', eur: 'EUR', pound: 'GBP', pounds: 'GBP', sterling: 'GBP', gbp: 'GBP', quid: 'GBP',
  yen: 'JPY', jpy: 'JPY', yuan: 'CNY', renminbi: 'CNY', rmb: 'CNY', cny: 'CNY', rupee: 'INR', rupees: 'INR', inr: 'INR', franc: 'CHF', francs: 'CHF', chf: 'CHF',
  'canadian dollar': 'CAD', 'canadian dollars': 'CAD', cad: 'CAD', 'australian dollar': 'AUD', 'australian dollars': 'AUD', aud: 'AUD', 'new zealand dollar': 'NZD', nzd: 'NZD',
  'hong kong dollar': 'HKD', hkd: 'HKD', 'singapore dollar': 'SGD', sgd: 'SGD', won: 'KRW', krw: 'KRW', peso: 'MXN', pesos: 'MXN', mxn: 'MXN', real: 'BRL', reais: 'BRL', brl: 'BRL',
  rand: 'ZAR', zar: 'ZAR', lira: 'TRY', try: 'TRY', krona: 'SEK', kronor: 'SEK', sek: 'SEK', krone: 'NOK', nok: 'NOK', dkk: 'DKK', zloty: 'PLN', pln: 'PLN', forint: 'HUF', huf: 'HUF',
  koruna: 'CZK', czk: 'CZK', shekel: 'ILS', ils: 'ILS', baht: 'THB', thb: 'THB', ringgit: 'MYR', myr: 'MYR', rupiah: 'IDR', idr: 'IDR', php: 'PHP', 'philippine peso': 'PHP', ron: 'RON', leu: 'RON', isk: 'ISK', bgn: 'BGN',
  naira: 'NGN', ngn: 'NGN', dinar: 'RSD', rsd: 'RSD', hryvnia: 'UAH', uah: 'UAH', 'kenyan shilling': 'KES', kes: 'KES', 'egyptian pound': 'EGP', egp: 'EGP', '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR'
};
const ECB = new Set('AUD BGN BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR'.split(' '));
const codeOf = word => { const w = String(word || '').toLowerCase().trim().replace(/[?.]$/, ''); return CURRENCY_NAMES[w] || (/^[a-z]{3}$/.test(w) ? w.toUpperCase() : null); };
const names = Object.keys(CURRENCY_NAMES).sort((a, b) => b.length - a.length).map(n => n.replace(/[$]/g, '\\$')).join('|');

const rates = cached('fx', HOUR, base => getJSON(`https://api.frankfurter.dev/v1/latest?base=${base}`));
const openRates = cached('fx-open', HOUR, base => getJSON(`https://open.er-api.com/v6/latest/${base}`));

const currency = {
  id: 'currency', title: 'Currency converter', family: 'Money', standalone: true, feedsMath: true,
  description: 'Convert money between currencies at today\'s exchange rate',
  examples: ['convert 100 USD to EUR', 'how much is 50 pounds in dollars', '1000 yen to euros', 'what is the dollar to naira exchange rate', 'exchange rate euro to pound', '250 euros in rupees', 'how many dollars is 20 euros'],
  pattern: new RegExp(`\\b(exchange rate|convert|in|to|into)\\b.*\\b(${names})\\b|[$€£¥₹]\\s?\\d`, 'i'),
  args: { amount: { type: 'number' }, from: { type: 'string', description: '3-letter currency code' }, to: { type: 'string', description: '3-letter currency code' } },
  extract(q) {
    const t = q.toLowerCase().replace(/,(?=\d{3})/g, '');
    const symbol = t.match(/([$€£¥₹])\s?(\d+(?:\.\d+)?)/);
    const m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)?\\s*(${names})\\s+(?:to|in|into|=|as|is how many)\\s+(?:\\w+\\s)?(${names})\\b`, 'i'));
    const rate = t.match(new RegExp(`(${names})\\s+(?:to|vs|versus|against|and)\\s+(${names})\\b`, 'i'));
    const howMany = t.match(new RegExp(`how many (${names}) (?:is|are|in|for)\\s+(\\d+(?:\\.\\d+)?)\\s*(${names})`, 'i'));
    if (howMany) return { amount: Number(howMany[2]), from: codeOf(howMany[3]), to: codeOf(howMany[1]) };
    if (m) return { amount: Number(m[1] || symbol?.[2] || 1), from: codeOf(m[2]), to: codeOf(m[3]) };
    if (symbol) { const to = t.match(new RegExp(`(?:to|in|into)\\s+(${names})\\b`, 'i')); if (to) return { amount: Number(symbol[2]), from: codeOf(symbol[1]), to: codeOf(to[1]) }; }
    if (rate) return { amount: 1, from: codeOf(rate[1]), to: codeOf(rate[2]) };
    return null;
  },
  async run({ amount = 1, from, to }) {
    from = codeOf(from) || from; to = codeOf(to) || to;
    let rate, date, source;
    if (ECB.has(from) && ECB.has(to)) {
      const data = await rates(from);
      rate = from === to ? 1 : data.rates[to]; date = data.date; source = { title: 'European Central Bank reference rates (Frankfurter)', url: 'https://www.frankfurter.app' };
    } else {
      const data = await openRates(from);
      rate = data.rates?.[to]; date = data.time_last_update_utc?.slice(5, 16); source = { title: 'ExchangeRate-API open rates', url: 'https://www.exchangerate-api.com' };
    }
    if (!rate) throw new Error(`no rate for ${from} → ${to}`);
    const result = amount * rate;
    const money = (v, c) => v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : 2, minimumFractionDigits: v >= 1 ? 2 : 0 }) + ' ' + c;
    return {
      facts: [`${money(amount, from)} = ${money(result, to)} at the rate of ${date} (1 ${from} = ${rate} ${to}; 1 ${to} = ${(1 / rate).toPrecision(6)} ${from}).`],
      card: { kind: 'big', headline: money(result, to), detail: `${money(amount, from)} · 1 ${from} = ${rate} ${to} · ${date}` },
      sources: [source], direct: `**${money(result, to)}**`, say: ''
    };
  }
};

const coinIndex = cached('coin-search', 24 * HOUR, query => getJSON(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`));
const crypto = {
  id: 'crypto', title: 'Crypto prices', family: 'Money', standalone: true, feedsMath: true,
  description: 'Live cryptocurrency prices, market cap and 24-hour change',
  examples: ['bitcoin price', 'how much is ethereum worth', 'price of solana', 'what is BTC at right now', 'dogecoin price in euros', 'is bitcoin up today', 'ETH market cap'],
  pattern: /\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|cardano|ada|xrp|ripple|litecoin|ltc|bnb|tether|usdt|usdc|polkadot|shiba|tron|avalanche|chainlink|crypto(currency)?|monero|toncoin|sui|pepe)\b/i,
  args: { coin: { type: 'string', description: 'coin name or symbol' }, vs: { type: 'string', description: 'fiat currency code, usually usd' } },
  extract: q => {
    const m = q.match(/\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|cardano|ada|xrp|ripple|litecoin|ltc|bnb|tether|usdt|usdc|polkadot|dot|shiba inu|shib|tron|trx|avalanche|avax|chainlink|link|monero|xmr|toncoin|ton|sui|pepe)\b/i);
    const vs = q.match(/\bin\s+(euros?|eur|pounds?|gbp|yen|jpy|usd|dollars?)\b/i);
    return m ? { coin: m[1], vs: vs ? codeOf(vs[1]) : 'USD' } : null;
  },
  async run({ coin, vs = 'USD' }) {
    const hits = await coinIndex(coin);
    const want = coin.toLowerCase();
    const matches = (hits.coins || []).filter(c => c.name.toLowerCase() === want || c.symbol.toLowerCase() === want || c.id === want);
    const rank = c => c.market_cap_rank || 1e9;
    const hit = (matches.length ? matches : hits.coins || []).slice().sort((a, b) => rank(a) - rank(b))[0];
    if (!hit) throw new Error(`no coin called ${coin}`);
    const cur = vs.toLowerCase();
    const data = await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${hit.id}&vs_currencies=${cur}&include_market_cap=true&include_24hr_change=true&include_last_updated_at=true`);
    const d = data[hit.id];
    const price = d[cur], change = d[`${cur}_24h_change`], cap = d[`${cur}_market_cap`];
    const money = v => v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : 2 }) + ' ' + vs.toUpperCase();
    return {
      facts: [`${hit.name} (${hit.symbol}) is trading at ${money(price)}, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)}% in the last 24 hours. Market cap: ${(cap / 1e9).toFixed(1)} billion ${vs.toUpperCase()} (rank #${hit.market_cap_rank}). Updated ${new Date(d.last_updated_at * 1000).toUTCString().slice(5, 22)} UTC.`],
      card: { kind: 'quote', name: hit.name, symbol: hit.symbol, price: money(price), change, detail: `Market cap ${(cap / 1e9).toFixed(1)}B ${vs.toUpperCase()} · rank #${hit.market_cap_rank}` },
      sources: [{ title: `CoinGecko: ${hit.name}`, url: `https://www.coingecko.com/en/coins/${hit.id}` }]
    };
  }
};

const symbolSearch = cached('ticker', 24 * HOUR, q => getJSON(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5&newsCount=0`));
const chart = cached('stock', 2 * MINUTE, s => getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`));
const stocks = {
  id: 'stocks', title: 'Stock quotes', family: 'Money', standalone: true, feedsMath: true,
  description: 'Live stock, ETF and index prices with the daily change',
  examples: ['apple stock price', 'how is TSLA doing today', 'NVDA share price', 'what is the S&P 500 at', 'Microsoft stock', 'price of Amazon shares', 'Dow Jones today', 'nasdaq index level'],
  pattern: /\b(stock|stocks|shares?|share price|ticker|s&p ?500|dow jones|nasdaq|ftse|nikkei|dax|index fund|etf)\b|\$[A-Z]{1,5}\b/i,
  args: { company: { type: 'string', description: 'company name, ticker or index name' } },
  extract: q => {
    const t = q.replace(/[?]/g, '');
    if (/\b(stock )?market\b[^?]*\b(open|closed|close|trading)\b|\b(open|closed)\b[^?]*\b(stock market|nyse|nasdaq|wall street)\b/i.test(t)) return { company: '^GSPC', session: true };
    const after = t.match(/\b(?:shares?|stocks?)\s+(?:of|in)\s+([A-Za-z][\w .&'-]*?)(?:\s+(?:worth|cost|be|now|rn|today|stock|shares?)\b|$)/i) || t.match(/[$€£]\s?\d[\d,.]*\s*(?:k|m)?\s+(?:of|in)\s+([A-Za-z][\w .&'-]*?)(?:\s+(?:stock|shares?)\b|$)/i);
    if (after) return { company: after[1].trim() };
    if (/s&p ?500/i.test(t)) return { company: '^GSPC' }; if (/dow jones|\bdow\b/i.test(t)) return { company: '^DJI' }; if (/nasdaq/i.test(t)) return { company: '^IXIC' };
    if (/ftse/i.test(t)) return { company: '^FTSE' }; if (/nikkei/i.test(t)) return { company: '^N225' }; if (/\bdax\b/i.test(t)) return { company: '^GDAXI' };
    const ticker = t.match(/\$([A-Z]{1,5})\b/) || t.match(/\b([A-Z]{2,5})\b(?=\s+(?:stock|shares?|price|doing|today))/);
    if (ticker) return { company: ticker[1] };
    const m = t.match(/(?:price of|how is|how's)\s+(.+?)\s+(?:stock|shares?|doing|trading)/i) || t.match(/^(.+?)\s+(?:stock|share|shares)\b/i) || t.match(/(?:stock price|share price) (?:of|for)\s+(.+)$/i);
    if (!m) return null;
    const company = m[1].replace(/^(what is|what's|whats|how much (is|are)|the)\s+/i, '').replace(/\b\d[\d,.]*\b/g, '').trim();
    return company.length > 1 ? { company } : null;
  },
  async run({ company, session }) {
    let symbol = company;
    if (!/^\^|^[A-Z.]{1,6}$/.test(company)) {
      const found = await symbolSearch(company);
      const hit = found.quotes?.find(q => ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(q.quoteType)) || found.quotes?.[0];
      if (!hit) throw new Error(`no ticker for ${company}`);
      symbol = hit.symbol;
    }
    const data = await chart(symbol);
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) throw new Error(`no quote for ${symbol}`);
    const price = meta.regularMarketPrice, prev = meta.chartPreviousClose ?? meta.previousClose;
    const closes = data.chart.result[0].indicators.quote[0].close.filter(Boolean);
    const prior = closes.length >= 2 ? closes.at(-2) : prev;
    const change = (price - prior) / prior * 100;
    const name = meta.longName || meta.shortName || symbol;
    const money = v => v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) + ' ' + (meta.currency || '');
    const at = new Date(meta.regularMarketTime * 1000);
    if (session) {
      const regular = meta.currentTradingPeriod?.regular;
      const now = Date.now() / 1000;
      const open = regular && now >= regular.start && now < regular.end;
      const local = new Date().toLocaleString('en-US', { timeZone: meta.exchangeTimezoneName || 'America/New_York', weekday: 'long', hour: 'numeric', minute: '2-digit' });
      const fact = open
        ? `The US stock market is open right now (it is ${local} in New York); regular trading runs 9:30 AM to 4:00 PM Eastern on weekdays.`
        : `The US stock market is closed right now (it is ${local} in New York). Regular trading runs 9:30 AM to 4:00 PM Eastern, Monday to Friday, except market holidays; the last session closed with the S&P 500 at ${money(price)}.`;
      return { facts: [fact], direct: open ? '**Open**' : '**Closed**', body: fact, card: { kind: 'metric', headline: open ? 'Market open' : 'Market closed', detail: `New York · ${local}` }, sources: [{ title: 'Yahoo Finance: trading session', url: 'https://finance.yahoo.com/quote/%5EGSPC' }] };
    }
    return {
      facts: [`${name} (${symbol}) last traded at ${money(price)} on ${at.toUTCString().slice(0, 22)} UTC, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)}% from the previous close of ${money(prior)}. Day range ${money(meta.regularMarketDayLow)} – ${money(meta.regularMarketDayHigh)}; 52-week range ${money(meta.fiftyTwoWeekLow)} – ${money(meta.fiftyTwoWeekHigh)}.`],
      card: { kind: 'quote', name, symbol, price: money(price), change, detail: `${meta.fullExchangeName || meta.exchangeName} · ${at.toUTCString().slice(5, 22)} UTC · 52w ${money(meta.fiftyTwoWeekLow)}–${money(meta.fiftyTwoWeekHigh)}`, spark: closes },
      sources: [{ title: `Yahoo Finance: ${symbol}`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}` }]
    };
  }
};

export default [currency, crypto, stocks];
