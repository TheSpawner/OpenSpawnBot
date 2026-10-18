import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { http, getJSON, cached, DAY, HOUR, clean, sentences, hostOf, siteOf } from './util.mjs';

const MAX_BYTES = 2_500_000;
const PASSAGE_WORDS = 90;

function chunk(blocks, meta) {
  const passages = [];
  let current = null;
  const flush = () => { if (current?.text) passages.push(current); current = null; };
  for (const block of blocks) {
    for (const sentence of sentences(block.text)) {
      if (current && (current.section !== block.section || current.words + sentence.split(' ').length > PASSAGE_WORDS)) flush();
      current ||= { ...meta, section: block.section, text: '', words: 0 };
      current.text += (current.text ? ' ' : '') + sentence;
      current.words += sentence.split(' ').length;
    }
    if (block.kind === 'row' || block.kind === 'item') {}
  }
  flush();
  return passages.filter(p => p.words >= 6 || /\d/.test(p.text)).map(({ words, ...p }) => p);
}

async function readWikipedia(url) {
  const title = decodeURIComponent(new URL(url).pathname.split('/wiki/')[1] || '').replace(/_/g, ' ');
  const lang = new URL(url).hostname.split('.')[0];
  const params = new URLSearchParams({ action: 'query', prop: 'extracts|info', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title, format: 'json', inprop: 'url' });
  const data = await getJSON(`https://${lang}.wikipedia.org/w/api.php?${params}`, { timeout: 7000 });
  const page = Object.values(data.query?.pages || {})[0];
  if (!page?.extract) throw new Error('no article');
  const blocks = [];
  let section = 'Overview';
  for (const line of page.extract.split('\n')) {
    const heading = line.match(/^=+\s*(.*?)\s*=+$/);
    if (heading) { section = heading[1]; continue; }
    if (/^(See also|References|External links|Notes|Further reading|Bibliography|Sources|Citations)$/i.test(section)) continue;
    if (line.trim().length > 25) blocks.push({ section, text: line });
  }
  return { title: page.title, blocks, lead: blocks.filter(b => b.section === 'Overview').map(b => b.text).join(' ') };
}

function snippetOf(node, section) {
  const code = String(node.textContent || '').replace(/\r/g, '').replace(/^\n+|\s+$/g, '');
  if (code.length < 12 || code.length > 2500 || !/[;{}()=<>:]/.test(code)) return null;
  const cls = `${node.getAttribute?.('class') || ''} ${node.querySelector?.('code')?.getAttribute?.('class') || ''}`;
  const lang = cls.match(/(?:language|lang|brush:?)-?\s*([a-z0-9+#-]+)/i)?.[1]?.toLowerCase() || '';
  return { section, code, lang };
}
function blocksFromHTML(html, snippets = []) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const blocks = [];
  let section = 'Overview';
  for (const node of document.querySelectorAll('h1,h2,h3,h4,p,li,tr,blockquote,pre,dd,dt,figcaption')) {
    const tag = node.tagName.toLowerCase();
    if (/^h\d$/.test(tag)) { section = clean(node.textContent).slice(0, 90) || section; continue; }
    if (tag === 'pre') { const s = snippetOf(node, section); if (s) snippets.push(s); continue; }
    if (node.closest('pre')) continue;
    if (tag === 'p' && node.closest('li,blockquote')) continue;
    if (tag === 'tr') {
      const cells = [...node.querySelectorAll('th,td')].map(c => clean(c.textContent)).filter(Boolean);
      if (cells.length >= 2) blocks.push({ section, kind: 'row', text: cells.join(' — ') + '.' });
      continue;
    }
    if (tag === 'li' && node.querySelector('li,p')) continue;
    const text = clean(node.textContent);
    if (text.length < 20 && !/\d/.test(text)) continue;
    blocks.push({ section, kind: tag === 'li' ? 'item' : 'p', text: /[.!?:]$/.test(text) ? text : text + '.' });
  }
  return blocks;
}

async function readHTML(url) {
  const response = await http(url, { timeout: 6500, headers: { accept: 'text/html,application/xhtml+xml' } });
  const type = response.headers.get('content-type') || '';
  if (!/html|xml|text\/plain/.test(type)) throw new Error(`not a page (${type.split(';')[0]})`);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const html = Buffer.concat(parts).toString('utf8');
  if (type.includes('text/plain')) return { title: hostOf(url), blocks: html.split(/\n\s*\n/).map(text => ({ section: 'Overview', text })) };
  const { document } = parseHTML(html);
  const published = document.querySelector('meta[property="article:published_time"],meta[name="date"],meta[itemprop="datePublished"],time[datetime]');
  const date = published?.getAttribute('content') || published?.getAttribute('datetime') || null;
  let article = null;
  try { article = new Readability(document, { charThreshold: 300 }).parse(); } catch {}
  const snippets = [];
  const blocks = article?.content ? blocksFromHTML(article.content, snippets) : blocksFromHTML(parseHTML(html).document.body?.innerHTML || '', snippets);
  return { title: clean(article?.title || document.title || hostOf(url)), blocks, snippets: snippets.slice(0, 12), date, byline: article?.byline || null };
}

const readUncached = async url => {
  const isWiki = /^https?:\/\/[a-z]{2,3}\.(m\.)?wikipedia\.org\/wiki\//.test(url);
  const doc = isWiki ? await readWikipedia(url) : await readHTML(url);
  const meta = { url, title: doc.title, site: siteOf(url), host: hostOf(url), date: doc.date || null };
  return { ...meta, lead: doc.lead || '', passages: chunk(doc.blocks, meta), snippets: doc.snippets || [] };
};

const readCached = cached('page2', DAY, readUncached);
const readFresh = cached('page2-fresh', HOUR, readUncached);
export const read = (url, { fresh = false } = {}) => (fresh ? readFresh : readCached)(url);
