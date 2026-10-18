const $ = s => document.querySelector(s);
const app = $('#app'), view = $('#view'), input = $('#input'), popover = $('#popover'), inspector = $('#inspector'), panes = document.querySelector('.panes');

const state = { threads: [], health: {}, tools: [], config: {}, encoders: {} };
let threadId = null, thread = null, page = 'chat', mode = 'auto', selectedTurn = null, inspectorTab = 'sources';
const live = new Map();
const caughtOpen = new Set();
let following = true;
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '';
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const favUrl = host => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
const fav = (host, cls = '') => host ? `<img class="fav ${cls}" src="${favUrl(host)}" alt="" width="14" height="14" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="fav ${cls}"></span>`;
const secs = ms => ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ktok = n => n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z"/></svg>',
  calc: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20zM12 10v4M12 17h.01"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>'
};
function inline(text) {
  let t = esc(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
  return t;
}
const ABBR = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|U\.S|U\.K|Inc|Ltd|Co|Corp|No|Fig|approx|est|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mt|ca)\.$/i;
function sentences(text) {
  const out = []; let buf = '';
  for (const piece of String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[*])/)) {
    buf = buf ? buf + ' ' + piece : piece;
    if (ABBR.test(buf) || /\b[A-Z]\.$/.test(buf)) continue;
    out.push(buf); buf = '';
  }
  if (buf) out.push(buf);
  return out;
}
function parseBlocks(md) {
  const blocks = []; let fence = null, para = null;
  for (const line of String(md).replace(/\r/g, '').split('\n')) {
    if (fence) { if (/^\s*```/.test(line)) { blocks.push(fence); fence = null; } else fence.text += line + '\n'; continue; }
    if (/^\s*```/.test(line)) { para = null; fence = { type: 'code', text: '' }; continue; }
    if (!line.trim()) { para = null; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { para = null; blocks.push({ type: 'heading', text: h[2].replace(/\*\*/g, '') }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { para = null; const last = blocks.at(-1); if (last?.type === 'table') last.rows.push(line); else blocks.push({ type: 'table', rows: [line] }); continue; }
    const item = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)/);
    if (item) { para = null; blocks.push({ type: 'item', ordered: /\d/.test(item[2]), depth: item[1].length >= 2 ? 1 : 0, text: item[3] }); continue; }
    if (para) para.text += ' ' + line.trim(); else { para = { type: 'paragraph', text: line.trim() }; blocks.push(para); }
  }
  if (fence) blocks.push(fence);
  for (const b of blocks) if (b.type === 'paragraph' || b.type === 'item') b.sentences = sentences(b.text).map(text => ({ text }));
  return blocks;
}
async function api(path, body, method) {
  const res = await fetch(path, body !== undefined ? { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: method || 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(message) { const t = $('#toast'); t.textContent = message; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 4200); }

function newTurn(base) {
  return { id: base.id, prompt: base.prompt, mode: base.mode, status: base.status || 'running', readAs: null, stage: null, stages: [], route: null, tools: {}, research: { sources: [] }, cards: [], vote: null, draft: '', claims: new Map(), cells: [], evidence: [], sources: [], facts: null, plan: null, steps: [], approvals: new Map(), result: base.result || null, error: base.error || null, started: base.started || Date.now() };
}
function apply(t, e) {
  switch (e.type) {
    case 'stage': t.stage = e.stage; t.stages.push({ stage: e.stage, at: e.at }); if (e.stage === 'route') t.route = e; if (e.stage === 'repair') t.repairing = true; break;
    case 'readAs': t.readAs = e.text; break;
    case 'tool': t.tools[e.id] = { ...(t.tools[e.id] || {}), ...e }; break;
    case 'research':
      if (e.kind === 'search') t.research.queries = e.queries;
      if (e.kind === 'results') { t.research.results = e.count; t.research.providers = e.providers; }
      if (e.kind === 'reading') t.research.sources = e.sources.map(s => ({ ...s, state: 'pending' }));
      if (e.kind === 'read') { const s = t.research.sources.find(x => x.url === e.url); if (s) s.state = e.ok ? 'ok' : 'failed'; if (e.ok) t.research.lastRead = e.url; }
      if (e.kind === 'ranked') { t.research.passages = e.passages; t.research.kept = e.kept; }
      break;
    case 'card': t.cards.push(e.card); break;
    case 'sources': t.sources = e.sources; t.evidence = e.evidence; break;
    case 'vote': t.vote = e.vote; break;
    case 'polar': t.polar = e.polar; break;
    case 'facts': t.facts = e.facts; break;
    case 'token': t.draft += e.text; break;
    case 'reset': t.draft = ''; t.claims = new Map(); break;
    case 'claim': t.claims.set(e.text, e); break;
    case 'cell': t.cells.push(e); break;
    case 'plan': t.plan = e.steps; t.steps = e.steps.map((step, i) => t.steps[i]?.step === step ? t.steps[i] : { step, status: 'pending' }); t.replanned ||= Boolean(e.replanned); break;
    case 'check': t.check = e; break;
    case 'step': t.steps[e.index] = { ...(t.steps[e.index] || {}), ...e }; break;
    case 'confirm': t.approvals.set(e.id, { ...e, status: 'waiting' }); break;
    case 'confirmed': if (e.id && t.approvals.has(e.id)) t.approvals.get(e.id).status = e.approved ? 'approved' : 'declined'; break;
    case 'done': t.result = e.result; t.status = 'done'; break;
    case 'error': t.error = e.error; t.status = e.error === 'Stopped.' ? 'stopped' : 'failed'; break;
  }
}
function fromSaved(turn) {
  const t = newTurn(turn);
  for (const e of turn.events || []) apply(t, e);
  t.status = turn.status; t.result = turn.result || null; t.error = turn.error || null;
  return t;
}
const stateOf = turn => live.get(turn.id) || turn._state || fromSaved(turn);
const modeOf = t => t.result?.mode || t.route?.mode || (t.plan ? 'act' : null);

const WX = c => c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 57 ? '🌦️' : c <= 67 ? '🌧️' : c <= 77 ? '🌨️' : c <= 82 ? '🌦️' : c <= 86 ? '🌨️' : '⛈️';
function spark(values) {
  if (!values?.length) return '';
  const min = Math.min(...values), max = Math.max(...values), w = 300, h = 38;
  const pts = values.map((v, i) => `${(i / (values.length - 1 || 1)) * w},${h - 4 - ((v - min) / (max - min || 1)) * (h - 8)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="M${pts.join(' L')}"/></svg>`;
}
function card(c) {
  const head = (label, extra = '') => `<div class="card-head">${esc(label)}${extra}</div>`;
  switch (c.kind) {
    case 'weather': return `<div class="card">${head('Weather', ` <span class="badge">${esc(c.place)}</span>`)}<div class="wx"><span class="ic">${WX(c.now.code)}</span><span class="temp">${c.now.temp}${esc(c.unit)}</span><div><div class="sky">${esc(c.now.sky || '')}</div><div class="sub">Feels ${c.now.feels}${esc(c.unit)} · Humidity ${c.now.humidity}% · Wind ${c.now.wind} ${esc(c.windUnit)}</div></div></div><div class="days">${c.days.map(d => `<div class="day"><b>${esc(d.label)}</b>${WX(d.code)} <span class="t">${d.max}° / ${d.min}°</span><div class="p">${d.rain ?? 0}% precip.</div></div>`).join('')}</div></div>`;
    case 'quote': return `<div class="card">${head(c.name, ` <span class="badge mono">${esc(c.symbol)}</span>`)}<div class="quote"><span class="metric">${esc(c.price)}</span><span class="chg ${c.change >= 0 ? 'up' : 'down'}">${c.change >= 0 ? '▲' : '▼'} ${Math.abs(c.change).toFixed(2)}%</span></div><div class="sub">${esc(c.detail)}</div>${spark(c.spark)}</div>`;
    case 'facts': return `<div class="card">${head(c.title, `${c.subtitle ? ` <span class="badge">${esc(c.subtitle)}</span>` : ''}${safeUrl(c.url) ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">Source ↗</a>` : ''}`)}<dl class="kv">${c.rows.map(r => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join('')}</dl></div>`;
    case 'list': return `<div class="card">${head(c.title)}<div class="rows">${c.items.slice(0, 10).map(i => `<div class="row${i.dim ? ' dim' : ''}"><span class="l">${esc(i.label)}</span><span>${safeUrl(i.url) ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.text)}</a>` : esc(i.text)}${i.meta ? `<span class="m">${esc(i.meta)}</span>` : ''}</span></div>`).join('')}</div></div>`;
    case 'chips': return `<div class="card">${head(c.title)}<div class="chips">${c.items.map(w => `<span class="badge">${esc(w)}</span>`).join('')}</div></div>`;
    case 'definition': return `<div class="card">${head('Dictionary')}<div class="metric">${esc(c.word)}</div>${c.senses.slice(0, 5).map(s => `<p style="margin:6px 0;font-size:13px"><span class="badge">${esc(s.pos.toLowerCase())}</span> ${esc(s.text)}${s.example ? `<br><span class="sub">“${esc(s.example)}”</span>` : ''}</p>`).join('')}</div>`;
    case 'calc': return `<div class="card">${head(c.title || 'Calculation')}<div class="metric">${esc(c.result)}</div><div class="sub">${c.plain ? esc(c.expression) : `<code>${esc(c.expression)}</code>`}</div></div>`;
    case 'color': return `<div class="card" style="display:flex;gap:14px;align-items:center"><div class="swatch" style="background:${esc(c.hex)}"></div><div>${head('Colour')}<div class="metric mono">${esc(c.hex)}</div><div class="sub">${esc(c.rgb)} · ${esc(c.hsl)}</div></div></div>`;
    case 'code': return `<div class="card">${head('Sandbox output')}<pre class="term">${esc(c.output || '(no output)')}</pre></div>`;
    case 'map': return `<div class="card">${head('Place')}<div class="metric">${esc(c.place)}</div><div class="sub">${c.lat.toFixed(4)}, ${c.lon.toFixed(4)} · <a href="https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=9/${c.lat}/${c.lon}" target="_blank" rel="noopener">Open map ↗</a></div></div>`;
    case 'page': return `<div class="card">${head('Reading', ` <span class="badge">${esc(c.host)}</span>`)}<div style="font-weight:600;margin-top:6px">${esc(c.title)}</div><div class="sub">${c.count} passages extracted</div></div>`;
    default: return `<div class="card">${head(toolTitle(c.tool) || 'Result')}<div class="metric${c.mono ? ' mono' : ''}">${esc(c.headline || '')}</div><div class="sub">${esc(c.detail || '')}</div></div>`;
  }
}
function verdict(v) {
  if (!v?.answer) return '';
  const confident = v.settled ?? (v.confidence >= 0.6 && v.agree >= 2);
  const share = Math.round(v.confidence * 100);
  const alts = (v.alternatives || []).slice(confident ? 1 : 0, 4).filter(a => !confident || a.sites.length > 1);
  return `<div class="card${confident ? '' : ' low'}">${head2(confident ? 'Cross-checked answer' : 'Sources disagree', confident ? 'ok' : 'warn', confident ? `${v.agree}/${v.of} sites` : `${v.of} sites compared`)}
    <div class="verdict-row"><div class="metric">${esc(confident ? v.answer : 'No single answer')}</div><div class="agree"><b>${share}%</b> of weighted evidence</div></div>
    <div class="bar"><span style="width:${share}%"></span></div>
    ${alts.length ? `<div class="alts">${alts.map(a => `<span class="badge">${esc(a.answer)} <span style="color:var(--faint)">${Math.round(a.share * 100)}%</span></span>`).join('')}</div>` : ''}</div>`;
}
function polarCard(p) {
  if (!p?.verdict || p.verdict === 'single') return '';
  const label = { yes: 'Yes', no: 'No', qualified: 'Not exactly', mixed: 'Disputed' }[p.verdict];
  const tone = p.verdict === 'yes' || p.verdict === 'no' ? 'ok' : 'warn';
  const count = (p.yes.length + p.no.length + p.qualified.length);
  return `<div class="card${tone === 'ok' ? '' : ' low'}">${head2('Yes / no check', tone, `${count} sites`)}
    <div class="verdict-row"><div class="metric">${esc(label)}</div><div class="agree">Tested: “${esc(p.statement)}”</div></div>
    <div class="alts">${[['support it', p.yes], ['contradict it', p.no], ['qualify it', p.qualified]].filter(([, l]) => l.length).map(([k, l]) => `<span class="badge">${l.length} ${l.length === 1 ? 'site' : 'sites'} ${k}</span>`).join('')}</div></div>`;
}
const head2 = (label, tone, badge) => `<div class="card-head">${esc(label)} <span class="badge ${tone}">${esc(badge)}</span></div>`;

function planHTML(t) {
  if (!t.plan && !t.result?.steps) return '';
  const steps = t.steps.length ? t.steps : (t.result?.steps || []).map(s => ({ ...s, status: s.ok ? 'done' : s.declined ? 'declined' : s.refused ? 'refused' : 'failed' }));
  const done = steps.filter(s => s.status === 'done').length;
  const approvals = [...t.approvals.values()];
  return `<div class="plan"><div class="plan-head">${ICON.bolt} Agent plan <span class="count">${done}/${steps.length} done</span></div>${steps.map((s, i) => {
    const status = s.status || (s.ok ? 'done' : 'pending');
    const waiting = approvals.filter(a => a.detail === s.step);
    const icon = status === 'done' ? '✓' : status === 'failed' || status === 'refused' ? '!' : status === 'declined' ? '–' : i + 1;
    return `<div class="step ${status}"><div class="step-row"><span class="step-n">${icon}</span><span class="step-text">${esc(s.step)}</span>${status === 'running' || status === 'choosing' ? '<span class="spinner"></span>' : ''}${s.tool ? `<span class="badge mono">${esc(s.tool)}</span>` : ''}</div>
      ${waiting.map(a => approvalHTML(t, a)).join('')}
      ${s.output && status === 'done' ? `<div class="step-detail">${esc(String(s.output).slice(0, 900))}</div>` : ''}
      ${s.media ? `<img class="shot" src="/api/media/${encodeURIComponent(s.media)}" alt="screenshot">` : ''}
      ${s.error && status !== 'done' ? `<div class="step-detail err">${esc(s.error)}</div>` : ''}</div>`;
  }).join('')}${approvals.filter(a => !steps.some(s => s.step === a.detail)).map(a => `<div class="step">${approvalHTML(t, a)}</div>`).join('')}</div>`;
}
function approvalHTML(t, a) {
  const args = Object.entries(a.args || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  if (a.status !== 'waiting') return `<div class="approve settled">${a.status === 'approved' ? ICON.check : ICON.x} ${esc(a.title)} — ${a.status}</div>`;
  return `<div class="approve"><div class="approve-title">${ICON.warn} Approval needed: ${esc(a.title)}</div><pre>${esc(a.tool)}\n${esc(args)}</pre><div class="approve-actions"><button class="btn primary" data-approve="${esc(t.id)}:${esc(a.id)}:1">Approve</button><button class="btn" data-approve="${esc(t.id)}:${esc(a.id)}:0">Decline</button></div></div>`;
}

function sourceIndex(t) {
  const sources = t.result?.sources || t.sources || [];
  const evidence = t.result?.evidence || t.evidence || [];
  const byEvidence = {};
  for (const e of evidence) { const i = sources.findIndex(s => s.url && s.url === e.url); byEvidence[e.id] = i >= 0 ? i + 1 : null; }
  return { sources, evidence, byEvidence };
}
function cites(t, ids, idx) {
  if (!ids?.length || t.result?.exact || t.result?.derived) return '';
  const seen = new Set();
  return ids.map(id => {
    const n = idx.byEvidence[id];
    if (n == null || seen.has(n)) return ''; seen.add(n);
    const ev = idx.evidence.find(e => e.id === id);
    const site = idx.sources[n - 1]?.host || idx.sources[n - 1]?.site || '';
    return `<button class="cite${ev?.tool ? ' exact' : ''}" data-turn="${esc(t.id)}" data-ev="${id}" aria-label="Source ${n}${site ? `: ${esc(site)}` : ''}">${n}</button>`;
  }).join('');
}
const TIP = { supported: 'Supported by the sources', partial: 'Partly supported: part of this sentence is not in the sources', unverified: 'Not confirmed by any source', contradicted: 'Contradicted by a source', ungrounded: 'Contains a number no source gives' };
const sentenceHTML = (t, s, idx, checking) => {
  const st = s.status || (checking ? 'checking' : '');
  const sites = s.sites?.length ? ` — confirmed by ${s.sites.length} independent site${s.sites.length > 1 ? 's' : ''}: ${s.sites.join(', ')}` : '';
  const tip = TIP[st] ? TIP[st] + sites : '';
  return `<span class="s ${st}${s.sites?.length >= 2 ? ' corroborated' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${inline(s.text)}</span>${st && st !== 'meta' ? cites(t, s.cites, idx) : ''} `;
};
function tableHTML(block, cellsFrom) {
  const split = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const rows = block.rows.map(split).filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || !c));
  if (!rows.length) return '';
  const [headRow, ...body] = rows; const cells = cellsFrom || [];
  return `<table><thead><tr>${headRow.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r, ri) => `<tr>${r.map((c, ci) => {
    const m = cells.find(x => x.row === ri && x.col === ci);
    const cls = m ? (m.removed || m.status === 'contradicted' || m.status === 'ungrounded' ? 'c-removed' : m.status === 'supported' ? '' : 'c-' + m.status) : '';
    return `<td class="${cls}"${m && m.status !== 'supported' ? ` title="${esc(m.status)}"` : ''}>${m?.removed ? '—' : inline(c)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
}
function blocksHTML(t, blocks, idx, drafting = false) {
  let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  blocks.forEach((b, bi) => {
    if (b.type === 'item') { const tag = b.ordered ? 'ol' : 'ul'; if (list !== tag) { close(); html += `<${tag}>`; list = tag; } } else close();
    const last = bi === blocks.length - 1;
    const sents = (b.sentences || []).map((s, si) => { const known = s.status ? s : (t.claims.get(s.text) || s); return sentenceHTML(t, known, idx, drafting && !(last && si === b.sentences.length - 1) && !known.status); }).join('');
    if (b.type === 'heading') html += `<h3>${inline(b.text)}</h3>`;
    else if (b.type === 'paragraph') html += `<p>${sents}</p>`;
    else if (b.type === 'item') html += `<li class="${b.depth ? 'sub' : ''}">${sents}</li>`;
    else if (b.type === 'code') html += `<pre><code>${esc(b.text)}</code></pre>`;
    else if (b.type === 'table') html += tableHTML(b, b.cells || t.cells);
  });
  close();
  return html;
}
function answerHTML(t) {
  const idx = sourceIndex(t);
  if (t.result) return `<div class="answer">${blocksHTML(t, t.result.blocks || parseBlocks(t.result.answer || ''), idx)}</div>`;
  if (!t.draft) return '';
  return `<div class="answer drafting">${blocksHTML(t, parseBlocks(t.draft), idx, true)}<span class="caret"></span></div>`;
}
function progressText(t) {
  const s = t.stage;
  if (t.plan) { const running = t.steps.find(x => x.status === 'running' || x.status === 'choosing'); if ([...t.approvals.values()].some(a => a.status === 'waiting')) return 'Waiting for your approval'; return running ? `Working: ${running.step}` : s === 'speak' ? 'Writing the report' : 'Planning'; }
  if (!s || s === 'understand') return 'Reading the request';
  if (s === 'route') return 'Choosing how to answer';
  if (s === 'plan') return 'Planning the steps';
  if (s === 'search') { const r = t.research; if (r.passages != null) return `Ranking ${r.passages} passages`; if (r.sources.length) return `Reading ${r.sources.filter(x => x.state !== 'pending').length}/${r.sources.length} pages`; return 'Searching the web'; }
  if (s === 'vote') return 'Cross-checking the answer across sites';
  if (s === 'speak') return t.draft ? 'Writing' : 'Selecting facts';
  if (s === 'verify') return 'Verifying every sentence';
  if (s === 'repair') return 'Rewriting a draft that failed verification';
  return 'Working';
}
const STAGE = {
  understand: 'Understand', search: 'Search', read: 'Read', crosscheck: 'Cross-check', tool: 'Tool', compose: 'Compose', verify: 'Verify'
};
function stagesFor(t) {
  const mode = t.route?.mode;
  if (mode && mode !== 'research') return ['understand', 'compose'];
  if (t.route?.format === 'tool' && t.route?.tool) return ['understand', 'tool', 'compose', 'verify'];
  return ['understand', 'search', 'read', 'crosscheck', 'compose', 'verify'];
}
function stageNow(t, list) {
  const s = t.stage, r = t.research;
  if (s === 'verify') return 'verify';
  if (s === 'repair') return 'compose';
  if (s === 'speak') return t.draft || !list.includes('crosscheck') ? 'compose' : 'crosscheck';
  if (s === 'vote' || s === 'polar') return 'crosscheck';
  if (s === 'search') return r.passages != null ? 'crosscheck' : r.sources.length ? 'read' : 'search';
  if (list.includes('tool') && Object.values(t.tools).some(x => !x.booster)) return 'tool';
  return 'understand';
}
function stageDetail(t, key) {
  const r = t.research, words = (t.draft.match(/\S+/g) || []).length;
  const claims = [...t.claims.values()], ok = claims.filter(c => c.status === 'supported' || c.status === 'partial').length;
  switch (key) {
    case 'understand': return t.route ? (t.route.tool && t.route.format === 'tool' ? t.route.tool.id : t.route.format || t.route.mode || 'routed') : 'routing';
    case 'search': return r.results != null ? `${r.results} hits` : `${(r.queries || []).length || 1} queries`;
    case 'read': return r.sources.length ? `${r.sources.filter(x => x.state === 'ok').length}/${r.sources.length} pages` : 'pages';
    case 'crosscheck': return t.vote?.answer ? `${t.vote.agree}/${t.vote.of} agree` : t.polar?.verdict ? `${(t.polar.yes?.length || 0) + (t.polar.no?.length || 0) + (t.polar.qualified?.length || 0)} sites` : t.facts ? `${t.facts.length} facts` : r.passages != null ? `${r.passages} passages` : 'sources';
    case 'tool': { const tool = Object.values(t.tools).find(x => !x.booster); return tool ? tool.id : 'tool'; }
    case 'compose': return t.repairing ? 'rewriting' : words ? `${words} words` : 'facts → words';
    case 'verify': return claims.length ? `${ok}/${claims.length} ok` : 'each sentence';
  }
  return '';
}
const hostName = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
function stageNowText(t, key) {
  const r = t.research, model = (state.health.model || '0.8B model').replace(/^Qwen3\.5-/, '');
  const claims = [...t.claims.values()], ok = claims.filter(c => c.status === 'supported' || c.status === 'partial').length;
  const sites = new Set([...(t.sources || []).map(x => x.site || hostName(x.url)), ...r.sources.map(x => x.site)].filter(Boolean)).size;
  if (t.stage === 'repair') return 'A sentence failed the fact-check, so the draft is being rewritten from the sources';
  switch (key) {
    case 'understand': return t.readAs ? `Following the chat: “${t.readAs}”` : 'Working out what kind of answer this needs';
    case 'search': return `Searching ${Math.max(2, (r.providers || []).filter(p => p.count).length || 0)} engines for “${(r.queries?.[0] || t.prompt).slice(0, 60)}”`;
    case 'read': return r.lastRead ? `Reading ${hostName(r.lastRead)}, cutting it into passages` : `Opening ${r.sources.length} pages from independent sites`;
    case 'crosscheck': return t.vote?.answer ? `${t.vote.agree} of ${t.vote.of} sites agree on “${String(t.vote.answer).slice(0, 40)}”` : t.polar?.statement ? `Testing “${t.polar.statement.slice(0, 50)}” against every site` : t.facts ? `Kept the ${t.facts.length} strongest facts out of ${r.passages ?? 'all'} passages` : `Ranking ${r.passages ?? ''} passages by relevance and source trust`;
    case 'tool': { const tool = Object.values(t.tools).find(x => !x.booster); return tool ? `Asking ${tool.title || tool.id} for the exact answer` : 'Running a tool'; }
    case 'compose': return t.draft ? `The ${model} model is writing from ${t.facts?.length || 'the'} checked facts` : `Handing the ${model} model only the checked facts`;
    case 'verify': return `Checking every sentence against ${sites || 'the'} sources: ${ok} of ${claims.length} hold up`;
  }
  return 'Working';
}
const phase = period => `animation-delay:-${Date.now() % period}ms`;
function pipelineHTML(t) {
  const list = stagesFor(t), now = stageNow(t, list), at = Math.max(0, list.indexOf(now));
  const fill = list.length > 1 ? (at / (list.length - 1)) * 100 : 0;
  const nodes = list.map((key, i) => `<div class="pipe-node ${i < at ? 'done' : i === at ? 'active' : 'todo'}"><span class="pdot"${i === at ? ` style="${phase(1600)}"` : ''}></span><b>${STAGE[key]}</b><small>${esc(stageDetail(t, key))}</small></div>`).join('');
  const loop = t.repairing && list.includes('verify') ? `<div class="pipe-loop" style="--from:${list.indexOf('compose')};--to:${list.indexOf('verify')};--n:${list.length}"><span>draft failed a check · rewriting</span></div>` : '';
  const r = t.research, claims = t.claims.size;
  const totals = [[r.results, 'hit'], [r.sources.filter(x => x.state === 'ok').length || null, 'page', 'read'], [r.passages, 'passage'], [t.facts?.length, 'fact'], [claims || null, 'sentence', 'checked']].filter(([v]) => v != null);
  return `<div class="pipe" style="--n:${list.length}">
    <div class="pipe-head"><span class="pipe-title"><i class="pipe-live" style="${phase(1600)}"></i>${esc((state.health.model || 'model').replace(/^Qwen3\.5-/, ''))} · external weights</span><span class="pipe-time" data-start="${t.started}">${secs(Date.now() - t.started)}</span></div>
    <div class="pipe-track">${loop}<div class="pipe-rail"><i style="width:${fill}%"></i><em style="${phase(1400)}"></em></div>${nodes}</div>
    <div class="pipe-now"><span class="prompt">›</span><span class="txt">${esc(stageNowText(t, now))}</span><span class="cursor" style="${phase(1000)}"></span></div>
    ${totals.length ? `<div class="pipe-totals">${totals.map(([v, l, after]) => `<span><b>${esc(String(v))}</b> ${l}${v === 1 ? '' : 's'}${after ? ' ' + after : ''}</span>`).join('')}</div>` : ''}
  </div>`;
}
setInterval(() => { for (const el of document.querySelectorAll('.pipe-time[data-start]')) el.textContent = secs(Date.now() - Number(el.dataset.start)); }, 200);

const toolTitle = id => id ? (state.tools.find(x => x.id === id)?.title || id) : '';
function metaHTML(t) {
  const m = modeOf(t);
  const label = { research: 'Research', act: 'Agent', chat: 'Chat', creative: 'Writing', transform: 'Rewrite', context: 'From this chat' }[m] || '';
  const bits = [`<span class="name">OpenSpawn Bot</span>`];
  const exactTool = t.result?.exact ? (t.result.tools?.[0]?.id || t.route?.tool?.id) : null;
  const computed = exactTool && state.tools.find(x => x.id === exactTool)?.family === 'Compute';
  if (label && !exactTool) bits.push(`<span class="badge ${m === 'act' ? 'accent' : ''}">${label}</span>`);
  if (t.route?.tool && !computed) bits.push(`<span class="badge">${esc(toolTitle(t.route.tool.id))}</span>`);
  if (t.status === 'running' && t.plan) bits.push(`<span class="progress"><span class="spinner"></span>${esc(progressText(t))}</span>`);
  const s = t.result?.stats;
  if (s && t.result.mode === 'research' && !t.result.exact) {
    bits.push(`<span class="badge ok" title="Sentences supported by at least one source">${ICON.check} ${s.supported}/${s.sentences + (s.cells || 0)} verified</span>`);
    if (s.corroborated) bits.push(`<span class="badge ok" title="Sentences that two or more independent sites each support on their own">${s.corroborated} cross-confirmed</span>`);
    if (s.partial) bits.push(`<span class="badge warn">${s.partial} partial</span>`);
  }
  if (t.result?.unconfirmed) bits.push('<span class="badge warn" title="No two independent sites agreed on the answer">unconfirmed</span>');
  if (t.result?.mode === 'context') bits.push('<span class="badge">from this chat</span>');
  if (computed) bits.push(`<span class="badge ok">${ICON.check} Calculated exactly</span>`);
  return `<div class="reply-meta">${bits.join('')}</div>`;
}
function afterHTML(t) {
  if (t.status === 'running') return '';
  const r = t.result || {};
  const sources = (r.sources || t.sources || []).filter(s => s.url);
  const caught = [...(r.removed || []), ...(r.firstDraftRemoved || []).map(x => ({ ...x, first: true }))];
  const parts = [];
  if (sources.length) parts.push(`<button class="favstrip" data-inspect="${esc(t.id)}:sources"><span class="stack">${sources.slice(0, 4).map(s => fav(s.host || hostOf(s.url))).join('')}</span>${plural(sources.length, 'source')}</button>`);
  if (caught.length) parts.push(`<button class="badge bad" data-caught="${esc(t.id)}">${caught.length} claim${caught.length > 1 ? 's' : ''} removed</button>`);
  parts.push('<span class="spacer"></span>');
  if (r.timings?.total) parts.push(`<button class="time" data-inspect="${esc(t.id)}:trace" title="Open the trace">${secs(r.timings.total)}</button>`);
  return `<div class="after">${parts.join('')}</div>${caughtOpen.has(t.id) && caught.length ? `<div class="caught"><b>Removed by the fact-checker before you saw it</b><ul>${caught.map(c => `<li><s>${esc(c.text)}</s> <small>${c.status === 'ungrounded' ? `number not in any source: ${esc((c.missing || []).join(', '))}` : 'contradicted by a source'}${c.first ? ' · first draft' : ''}</small></li>`).join('')}</ul></div>` : ''}`;
}
const shownTurns = new Set();
function turnHTML(t) {
  const cards = [verdict(t.result?.vote || t.vote), polarCard(t.result?.polar || t.polar), ...(t.result?.cards || t.cards).map(card)].filter(Boolean).join('');
  const seen = shownTurns.has(t.id); shownTurns.add(t.id);
  return `<article class="turn${seen ? ' seen' : ''}" id="turn-${esc(t.id)}" data-select="${esc(t.id)}">
    <div class="ask"><div class="avatar user">You</div><div><div class="ask-text">${esc(t.prompt)}</div>${t.readAs ? `<div class="read-as">Interpreted as “${esc(t.readAs)}”</div>` : ''}</div></div>
    <div class="reply"><div class="avatar bot"><img class="mark" src="logo-96.png" alt=""></div><div class="reply-body">
      ${metaHTML(t)}${t.status === 'running' && !t.plan ? pipelineHTML(t) : ''}${planHTML(t)}${cards ? `<div class="cards">${cards}</div>` : ''}${answerHTML(t)}
      ${t.error ? `<div class="error-box">${esc(t.error)}</div>` : ''}${afterHTML(t)}
    </div></div></article>`;
}

function inspectorHTML() {
  const turns = thread?.turns || [];
  const turn = turns.find(x => x.id === selectedTurn) || turns.at(-1);
  if (!turn || page !== 'chat') return `<div class="tabs"><button class="on">Inspector</button></div><div class="insp-body"><div class="insp-empty">Sources, the latency trace and the evidence behind each answer appear here.</div></div>`;
  const t = stateOf(turn);
  const r = t.result || {};
  const sources = (r.sources || t.sources || []).filter(s => s.url);
  const evidence = r.evidence || t.evidence || [];
  const tabs = [['sources', 'Sources', sources.length], ['trace', 'Trace', ''], ['evidence', 'Evidence', evidence.length]];
  let body = '';
  if (inspectorTab === 'sources') body = sources.length ? sources.map((s, i) => { const host = s.host || hostOf(s.url); return `<a class="src" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener"><span class="n">${i + 1}</span><span class="host">${fav(host)}<span>${esc(host)}</span>${s.tool ? '<span class="badge ok" style="height:16px;font-size:10px">tool</span>' : ''}</span><span class="title" title="${esc(s.title)}">${esc(s.title || host)}</span>${s.trust != null ? `<span class="tbar" title="Trust ${Math.round(s.trust * 100)}%"><span style="width:${Math.round(s.trust * 100)}%"></span></span>` : ''}</a>`; }).join('') : `<div class="insp-empty">${t.status === 'running' ? 'Collecting sources…' : 'No web sources for this answer.'}</div>`;
  if (inspectorTab === 'trace') body = traceHTML(t);
  if (inspectorTab === 'evidence') body = (t.facts?.length ? `<div class="insp-section"><h4>Facts given to the language model</h4>${t.facts.map((f, i) => `<div class="ev"><div class="ev-head"><b>${i + 1}</b></div>${esc(f.text)}</div>`).join('')}</div>` : '') + (evidence.length ? `<div class="insp-section"><h4>Evidence checked against</h4>${evidence.map(e => `<div class="ev"><div class="ev-head">${fav(e.host || hostOf(e.url))}<span>[${e.id}] ${esc(e.site || e.host || '')}</span>${e.relevance != null ? `<span class="badge mono">${Math.round(e.relevance * 100)}%</span>` : ''}</div>${esc(e.text.slice(0, 420))}${e.text.length > 420 ? '…' : ''}</div>`).join('')}</div>` : '') || '<div class="insp-empty">No evidence for this turn.</div>';
  return `<div class="tabs">${tabs.map(([id, label, n]) => `<button class="${inspectorTab === id ? 'on' : ''}" data-tab="${id}">${label}${n !== '' ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div><div class="insp-body">${body}</div>`;
}
function traceHTML(t) {
  const r = t.result || {};
  const tm = r.timings || {};
  const order = [['rewrite', 'Rewrite'], ['route', 'Route'], ['tools', 'Tools'], ['research', 'Research'], ['vote', 'Vote'], ['polar', 'Yes/no check'], ['facts', 'Select facts'], ['speak', 'Write'], ['verify', 'Verify'], ['repair', 'Repair']];
  const rows = order.filter(([k]) => tm[k] != null);
  const total = tm.total || Math.max(1, ...rows.map(([k]) => tm[k]));
  let cursor = (tm.rewrite || 0) + (tm.route || 0);
  const wf = rows.map(([k, label]) => {
    const start = k === 'rewrite' ? 0 : k === 'route' ? (tm.rewrite || 0) : k === 'tools' || k === 'research' ? (tm.rewrite || 0) + (tm.route || 0) : cursor;
    if (!['rewrite', 'route', 'tools'].includes(k)) cursor = start + tm[k];
    return `<div class="wf-row"><span class="k">${label}</span><span class="track"><span class="seg" style="left:${(start / total) * 100}%;width:${Math.max(0.6, (tm[k] / total) * 100)}%"></span></span><span class="v">${secs(tm[k])}</span></div>`;
  }).join('');
  const route = t.route?.ranked?.map(x => `<tr><td>${x.sim.toFixed(3)}${x.pattern ? '*' : ''}</td><td>${esc(x.id)}</td></tr>`).join('') || '';
  const alts = (r.vote?.alternatives || []).map(a => `<tr><td>${Math.round(a.share * 100)}%</td><td>${esc(a.answer)} — ${esc(a.sites.join(', '))}</td></tr>`).join('');
  const s = r.stats;
  return `${wf ? `<div class="insp-section"><h4>Latency · ${secs(total)}</h4><div class="wf">${wf}</div></div>` : ''}
    ${s ? `<div class="insp-section"><h4>Verification</h4><table class="insp-table"><tr><td>supported</td><td>${s.supported}</td></tr><tr><td>partial</td><td>${s.partial || 0}</td></tr><tr><td>unconfirmed</td><td>${s.unverified}</td></tr><tr><td>removed</td><td>${s.removed}</td></tr>${r.repaired ? '<tr><td>repair</td><td>first draft rewritten</td></tr>' : ''}</table></div>` : ''}
    ${route ? `<div class="insp-section"><h4>Router · cosine similarity</h4><table class="insp-table">${route}</table></div>` : ''}
    ${alts ? `<div class="insp-section"><h4>Cross-site vote</h4><table class="insp-table">${alts}</table></div>` : ''}
    ${t.research?.providers?.length ? `<div class="insp-section"><h4>Search providers</h4><table class="insp-table">${t.research.providers.map(p => `<tr><td>${esc(p.name)}</td><td>${p.count} results${p.error ? ` · ${esc(p.error)}` : ''}</td></tr>`).join('')}</table></div>` : ''}
    ${!wf && !s ? `<div class="insp-empty">${t.status === 'running' ? 'The trace fills in as the work happens.' : 'No trace for this turn.'}</div>` : ''}`;
}
function renderInspector() { inspector.innerHTML = inspectorHTML(); }

const IDEAS = {
  research: { label: 'Research', icon: 'search', items: [
    ['Who won the 2026 FIFA World Cup?', 'Current events · cross-checked'], ['Explain how mRNA vaccines work', 'Explanation · verified sentences'],
    ['Compare solar and wind power', 'Comparison · table'], ['What is the latest iPhone and what changed?', 'Product news · cross-checked'],
    ['Why is the sky blue?', 'Science · verified sentences'], ['How do I get rid of fruit flies?', 'How-to · cited'],
    ['Is intermittent fasting backed by evidence?', 'Yes / no check across sites'], ['Who is the CEO of Nvidia?', 'Fact · sites vote']] },
  live: { label: 'Live data', icon: 'cloud', items: [
    ['Do I need a jacket in Tokyo tomorrow?', 'Live forecast'], ['What is the air quality in Delhi right now?', 'Live air quality'],
    ['Convert 250 euros to Japanese yen', 'Live exchange rate'], ['What is Bitcoin trading at?', 'Live crypto price'],
    ['How is Apple stock doing today?', 'Live stock quote'], ['When is sunset in Paris today?', 'Sun times'],
    ['Any big earthquakes this week?', 'USGS live feed'], ['What is on Hacker News right now?', 'Live feed']] },
  maths: { label: 'Maths', icon: 'calc', items: [
    ['If I invest $100 a month at 7% for 20 years, what do I end up with?', 'Exact maths'], ['Solve 3x^2 - 5x + 2 = 0', 'Equation solver'],
    ['How many days until Christmas?', 'Date maths'], ['Convert 72 °F to Celsius', 'Unit conversion'],
    ['What is an 18% tip on $64.50?', 'Exact maths'], ['How far is London from New York?', 'Great-circle distance'],
    ['Generate a strong 20-character password', 'Password generator'], ['Pick a random number between 1 and 100', 'True random']] },
  browser: { label: 'Browser', icon: 'globe', items: [
    ['Open YouTube and search for lofi music', 'Agent · its own browser'], ['Open YouTube and play some jazz', 'Agent · its own browser'],
    ['Go to Wikipedia and search for black holes', 'Agent · its own browser'], ['Search Amazon for wireless headphones', 'Agent · its own browser'],
    ['Open GitHub and search for llama.cpp', 'Agent · its own browser'], ['Search Reddit for home espresso tips', 'Agent · its own browser'],
    ['Open Google Maps and search for coffee in Lisbon', 'Agent · its own browser'], ['Open YouTube, search for cats and play the first video', 'Agent · its own browser']] },
  writing: { label: 'Writing', icon: 'pen', items: [
    ['Write a haiku about autumn', 'Creative'], ['Draft a polite email asking for a deadline extension', 'Writing'],
    ['Brainstorm names for a coffee shop', 'Creative'], ['Write a short bedtime story about a dragon', 'Creative'],
    ['Rewrite this to sound professional: hey guys the meeting moved to 3', 'Rewrite'], ['Write a birthday message for my mom', 'Writing'],
    ['Write a thank-you note to my teacher', 'Writing'], ['Write a limerick about a cat', 'Creative']] },
  language: { label: 'Language', icon: 'chat', items: [
    ['How do I say thank you in Japanese?', 'Translation · Wiktionary'], ['Translate "where is the train station" into French', 'Translation'],
    ['What does "ephemeral" mean?', 'Dictionary'], ['Give me synonyms for "happy"', 'Thesaurus'],
    ['How do you say good night in German?', 'Translation'], ['Translate "I love you" into Italian', 'Translation'],
    ['Define the word "serendipity"', 'Dictionary'], ['Tell me a joke', 'Joke']] },
  knowledge: { label: 'Data', icon: 'book', items: [
    ['What is the population of Brazil?', 'World Bank · exact'], ['How many calories are in an avocado?', 'Nutrition database'],
    ['Find books by Ursula K. Le Guin', 'Open Library'], ['Latest research papers on protein folding', 'arXiv'],
    ['What is the newest version of React?', 'Package registry'], ['How much protein is in an egg?', 'Nutrition database'],
    ['What is the hex code for teal?', 'Colour'], ['What is the GDP of Japan?', 'World Bank · exact']] }
};
ICON.pen = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
ICON.book = '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>';
const shuffled = list => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ideas = { extra: 0, cat: 'all', order: Object.fromEntries(Object.entries(IDEAS).map(([k, g]) => [k, shuffled(g.items)])), at: Object.fromEntries(Object.keys(IDEAS).map(k => [k, 0])), shown: [] };
function nextIdeas() {
  if (ideas.cat === 'all') {
    const keys = Object.keys(ideas.order), take = k => [k, ...ideas.order[k][ideas.at[k]++ % ideas.order[k].length]];
    ideas.shown = keys.map(take);
    while (ideas.shown.length < 8) ideas.shown.push(take(keys[ideas.extra++ % keys.length]));
  }
  else { const list = ideas.order[ideas.cat], n = Math.min(8, list.length); ideas.shown = Array.from({ length: n }, (_, i) => [ideas.cat, ...list[(ideas.at[ideas.cat] + i) % list.length]]); ideas.at[ideas.cat] += n; }
}
const startersHTML = () => ideas.shown.map(([k, q, sub], i) => `<button class="starter" data-ask="${esc(q)}" style="animation-delay:${i * 35}ms"><span class="ico">${ICON[IDEAS[k].icon]}</span><b>${esc(q)}</b><span>${esc(sub)}</span></button>`).join('');
function homeHTML() {
  if (!ideas.shown.length) nextIdeas();
  return `<div class="home">
    <img class="home-logo" src="logo-96.png" alt="">
    <h1>Knows nothing. Looks everything up.</h1>
    <p>A 0.8B model whose every fact is looked up live and cross-checked.</p>
    <div class="idea-tabs" role="tablist">${[['all', 'All'], ...Object.entries(IDEAS).map(([k, g]) => [k, g.label])].map(([k, label]) => `<button role="tab" aria-selected="${ideas.cat === k}" data-idea-cat="${k}">${esc(label)}</button>`).join('')}</div>
    <div class="starters" id="starters">${startersHTML()}</div>
  </div>`;
}
function showIdeas() { const box = $('#starters'); if (box) box.innerHTML = startersHTML(); document.querySelectorAll('[data-idea-cat]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ideaCat === ideas.cat))); }
view.addEventListener('click', e => {
  const tab = e.target.closest('[data-idea-cat]');
  if (tab) { ideas.cat = tab.dataset.ideaCat; nextIdeas(); showIdeas(); }
});
setInterval(() => {
  const home = view.querySelector('.home');
  if (!home || ideas.cat !== 'all' || document.visibilityState !== 'visible' || matchMedia('(prefers-reduced-motion: reduce)').matches || home.querySelector('.starters:hover, .starters:focus-within, .idea-tabs:hover')) return;
  nextIdeas(); showIdeas();
}, 9000);
let toolFilter = '';
let deleteArmed = null, clearArmed = false, armTimer = null;
const arm = (kind, value) => { clearTimeout(armTimer); deleteArmed = kind === 'one' ? value : null; clearArmed = kind === 'all'; armTimer = setTimeout(() => { deleteArmed = null; clearArmed = false; renderRail(); }, 4000); renderRail(); };
function toolsHTML() {
  const families = {};
  const q = toolFilter.toLowerCase();
  for (const t of state.tools) if (!q || `${t.id} ${t.title} ${t.description}`.toLowerCase().includes(q)) (families[t.family] ||= []).push(t);
  const riskBadge = t => t.risk === 'read' ? '<span class="badge ok">read-only</span>' : t.risk === 'harmless' ? '<span class="badge">safe</span>' : t.risk === 'change' || t.risk === 'depends' ? '<span class="badge warn">asks first</span>' : t.standalone ? '<span class="badge accent">direct</span>' : t.booster ? '<span class="badge">oracle</span>' : '<span class="badge">research</span>';
  return `<div class="page"><div class="page-head"><div><h2>Tools</h2><p>${state.tools.length} tools across files, the shell, the web, a browser, the desktop and structured data. The router matches requests to tools by meaning in about 5 ms; the language model never has to choose from the whole list.</p></div><div class="tools-right"><label class="field">${ICON.search}<input id="toolFilter" placeholder="Filter tools" value="${esc(toolFilter)}"></label></div></div>
    ${Object.entries(families).map(([family, list]) => `<div class="family"><div class="section-head">${esc(family)} · ${list.length}</div><div class="tool-grid">${list.map(t => `<div class="tool"><div class="tool-top"><b>${esc(t.id)}</b>${riskBadge(t)}</div><p>${esc(t.description)}</p>${(t.examples || []).slice(0, 2).map(e => `<button class="try" data-ask="${esc(e)}">→ ${esc(e)}</button>`).join('')}</div>`).join('')}</div></div>`).join('') || '<div class="insp-empty">No tools match.</div>'}</div>`;
}
async function trustHTML() {
  const rows = await api('/api/trust').catch(() => []);
  return `<div class="page"><div class="page-head"><div><h2>Source trust</h2><p>Every site starts from a prior: encyclopedias and agencies high, forums low. After each cross-checked answer, sites that agreed with the consensus gain trust and sites that backed a losing answer lose some. Trust weights both which pages are read and how much each one's vote counts.</p></div></div>
    ${rows.length ? `<table class="table"><thead><tr><th>Site</th><th class="num">Trust</th><th class="num">Prior</th><th class="num">Agreed</th><th class="num">Disagreed</th></tr></thead><tbody>${rows.map(r => `<tr><td><span class="site">${fav(r.site, 'lg')}${esc(r.site)}</span></td><td class="num"><span class="meter"><i><span style="width:${Math.round(r.trust * 100)}%"></span></i>${Math.round(r.trust * 100)}%</span></td><td class="num">${Math.round(r.prior * 100)}%</td><td class="num">${r.agree}</td><td class="num">${r.disagree}</td></tr>`).join('')}</tbody></table>` : '<div class="insp-empty">Nothing learned yet. Ask a few factual questions.</div>'}</div>`;
}
function aboutHTML() {
  const e = state.encoders || {}, h = state.health;
  return `<div class="page arch"><div class="page-head"><div><h2>Architecture</h2><p>The language model's weights are not trusted with a single fact. It writes; everything it says comes from live research, structured sources and tools, and every sentence is checked before you read it.</p></div></div>
  <div class="arch-flow">
    <div><b>Route</b><span>The request is embedded and compared with every tool's example requests and every mode (research, agent, chat). Exact tools — maths, units, dates, money, weather — answer without the language model.</span></div>
    <div><b>Research</b><span>Three search engines are queried at once and their rankings fused; the best pages are read in parallel and cut into passages. Wikidata and the World Bank answer structured questions exactly.</span></div>
    <div><b>Rank &amp; vote</b><span>A cross-encoder ranks every passage, weighted by each site's learned trust. An extractive reader quotes the answer from each passage; answers are normalised and voted on, one vote per site.</span></div>
    <div><b>Write</b><span>The model is handed a short list of selected evidence sentences and only rewrites them: paraphrase is a language skill, not a knowledge skill.</span></div>
    <div><b>Verify</b><span>Each sentence is checked by natural-language inference against the closest evidence from all sources; every number must appear in a source. Contradicted or invented sentences are cut; a failing draft is rewritten once.</span></div>
    <div><b>Act</b><span>For tasks, the model writes a plan in plain English; System One maps each step to one of ${state.tools.length} tools and finds the element a step refers to; the model fills arguments under a JSON-schema grammar. Anything that changes your computer waits for approval.</span></div>
    <div><b>Learn</b><span>Sites that agree with the consensus earn trust; sites that do not, lose some.</span></div></div>
  <div class="section-head">Models</div>
  <table class="table"><tbody><tr><td>Mouth</td><td>${esc(h.model || '')} · ${h.context ? ktok(h.context) + ' context' : ''}${h.vision ? ' · vision' : ''}</td></tr><tr><td>Embed</td><td><code>${esc(e.embed || '')}</code></td></tr><tr><td>Rerank</td><td><code>${esc(e.rerank || '')}</code></td></tr><tr><td>Verify</td><td><code>${esc(e.nli || '')}</code></td></tr><tr><td>Extract</td><td><code>${esc(e.extract || '')}</code></td></tr></tbody></table></div>`;
}

function renderRail() {
  const q = ($('#threadSearch').value || '').toLowerCase();
  const list = state.threads.filter(t => t.title.toLowerCase().includes(q));
  const day = 864e5, today = new Date().setHours(0, 0, 0, 0);
  const group = u => u >= today ? 'Today' : u >= today - day ? 'Yesterday' : u >= today - 6 * day ? 'This week' : 'Older';
  let last = null;
  $('#threads').innerHTML = list.length ? list.map(t => {
    const g = group(t.updated || 0), head = g !== last ? `<div class="thread-group">${g}</div>` : '';
    last = g;
    const armed = deleteArmed === t.id;
    const del = armed ? `<button class="del armed" data-delete-confirm="${esc(t.id)}" title="Delete this chat for good">Delete</button>` : `<button class="del" data-delete="${esc(t.id)}" title="Delete chat" aria-label="Delete chat">${ICON.x}</button>`;
    return `${head}<div class="thread${t.id === threadId && page === 'chat' ? ' active' : ''}${armed ? ' arming' : ''}" data-thread="${esc(t.id)}">${t.running ? '<span class="dot live"></span>' : ''}<span class="t">${esc(t.title)}</span>${del}</div>`;
  }).join('') : `<div class="empty-note">${q ? 'No matching chats.' : 'Your chats appear here.'}</div>`;
  const clear = $('#clearAll');
  clear.hidden = !state.threads.length;
  clear.classList.toggle('armed', clearArmed);
  clear.textContent = clearArmed ? `Delete all ${state.threads.length}?` : 'Clear all';
  document.querySelectorAll('.rail-nav [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === page));
  $('#toolCount').textContent = state.tools.length || '';
  const h = state.health;
  const row = (label, s, value) => `<div class="sys-row"><span class="dot ${s === 'ready' ? 'ok' : ['starting', 'loading', 'fallback', 'downloading'].includes(s) ? 'wait' : 'bad'}"></span>${label}<b title="${esc(value)}">${esc(value)}</b></div>`;
  $('#system').innerHTML = row('Language model', h.llm, h.llm === 'ready' ? `${ktok(h.context || 0)} ctx${h.vision ? ' · vision' : ''}` : h.llm === 'downloading' ? `${Math.round(100 * (h.download?.received || 0) / (h.download?.total || 1))}%` : h.llm || '…') + row('Search', h.search, h.search === 'ready' ? 'SearXNG + direct' : h.search === 'fallback' ? 'direct engines' : h.search === 'installing' ? 'installing SearXNG' : h.search || '…') + row('Reflex', h.reflex, h.reflex === 'ready' ? `4 encoders` : h.reflex || '…') + (h.browser ? row('Browser', h.browser.name ? 'ready' : 'bad', h.browser.name ? `${h.browser.name} · own profile` : 'none found') : '');
  $('#modelPill').innerHTML = `<span class="dot ${h.llm === 'ready' ? 'ok' : h.llm === 'missing' || h.llm === 'off' ? 'bad' : 'wait'}"></span>${esc(h.model || 'Model')} <code>${h.llm === 'ready' ? ktok(h.context || 0) : esc(h.llm || '')}</code>`;
}
async function render() {
  renderRail();
  app.classList.toggle('busy', live.size > 0);
  $('#composerWrap').hidden = page !== 'chat';
  panes.classList.toggle('home-mode', page === 'chat' && !thread);
  if (page === 'tools') { view.innerHTML = toolsHTML(); renderInspector(); return; }
  if (page === 'about') { view.innerHTML = aboutHTML(); renderInspector(); return; }
  if (page === 'trust') { view.innerHTML = await trustHTML(); renderInspector(); return; }
  if (!thread) { view.innerHTML = homeHTML(); renderInspector(); syncComposer(); return; }
  view.innerHTML = `<div class="column">${thread.turns.map(turn => turnHTML(stateOf(turn))).join('')}</div>`;
  if (following) view.scrollTop = view.scrollHeight;
  renderInspector();
  syncComposer();
}
let frame = 0;
function renderTurn(taskId) {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const t = live.get(taskId); const el = document.getElementById('turn-' + taskId);
    if (!t || !el) return render();
    el.outerHTML = turnHTML(t);
    app.classList.toggle('busy', live.size > 0);
    if (following) view.scrollTop = view.scrollHeight;
    if (!selectedTurn || selectedTurn === taskId) renderInspector();
  });
}
function syncComposer() {
  const running = thread && thread.turns.some(t => live.has(t.id));
  $('#send').hidden = Boolean(running); $('#stop').hidden = !running;
  $('#send').disabled = !input.value.trim();
}

async function refresh() {
  const s = await api('/api/state').catch(() => null);
  if (!s) { state.health = { llm: 'off', search: 'off', reflex: 'off' }; renderRail(); return; }
  Object.assign(state, s); renderRail();
}
async function openThread(id) {
  page = 'chat'; following = true; selectedTurn = null;
  if (!id) { threadId = null; thread = null; return render(); }
  threadId = id;
  thread = await api('/api/thread/' + id).catch(() => null);
  if (!thread) { threadId = null; location.hash = ''; }
  for (const turn of thread?.turns || []) if (turn.status === 'running' && !live.has(turn.id)) follow(turn.id, turn);
  render();
}
function follow(taskId, base) {
  const t = newTurn({ ...base, id: taskId });
  live.set(taskId, t);
  const source = new EventSource('/api/stream/' + taskId);
  source.onmessage = msg => {
    const e = JSON.parse(msg.data);
    apply(t, e);
    if (e.type === 'done' || e.type === 'error') {
      source.close();
      const turn = thread?.turns.find(x => x.id === taskId);
      if (turn) { turn.status = t.status; turn.result = t.result; turn.error = t.error; turn._state = t; }
      live.delete(taskId);
      refresh().then(render);
      return;
    }
    if (thread?.turns.some(x => x.id === taskId)) renderTurn(taskId);
  };
  source.onerror = () => { if (t.status === 'running') { source.close(); live.delete(taskId); openThread(threadId); } };
}
async function ask(prompt) {
  prompt = prompt.trim();
  if (!prompt) return;
  if (state.health.llm !== 'ready') { toast(state.health.llm === 'missing' ? 'The language model is not installed yet — open Settings and press Download.' : 'The language model is still starting — one moment.'); return; }
  page = 'chat'; following = true;
  try {
    const { taskId, threadId: tid } = await api('/api/ask', { prompt, threadId: threadId || undefined, mode });
    input.value = ''; autosize();
    if (tid !== threadId || !thread) { threadId = tid; thread = { id: tid, title: prompt.slice(0, 64), turns: [] }; history.replaceState(null, '', '#/t/' + tid); }
    thread.turns.push({ id: taskId, prompt, mode, status: 'running', events: [] });
    selectedTurn = taskId;
    follow(taskId, { prompt, mode, status: 'running' });
    refresh(); render();
  } catch (error) { toast(error.message); }
}

function showEvidence(button) {
  const turn = thread?.turns.find(x => x.id === button.dataset.turn);
  const t = turn ? stateOf(turn) : null;
  if (!t) return;
  const e = sourceIndex(t).evidence.find(x => x.id === Number(button.dataset.ev));
  if (!e) return;
  const host = e.host || hostOf(e.url);
  popover.innerHTML = `<div class="ph">${fav(host)}<span>${esc(host || e.title)}</span>${e.section && !/^(Overview|Search snippet)$/.test(e.section) ? `<span>· ${esc(e.section)}</span>` : ''}</div><div class="pt">${esc(e.title || '')}</div><blockquote>${esc(e.text)}</blockquote><div class="pf"><span>${e.trust != null ? `trust ${Math.round(e.trust * 100)}%` : ''}${e.relevance != null ? ` · relevance ${Math.round(e.relevance * 100)}%` : ''}</span>${safeUrl(e.url) ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div>`;
  popover.hidden = false;
  const r = button.getBoundingClientRect(), p = popover.getBoundingClientRect();
  let top = r.bottom + 8; const left = Math.min(Math.max(12, r.left - 20), window.innerWidth - p.width - 12);
  if (top + p.height > window.innerHeight - 12) top = r.top - p.height - 8;
  popover.style.top = top + 'px'; popover.style.left = left + 'px';
  document.querySelectorAll('.cite.on').forEach(c => c.classList.remove('on')); button.classList.add('on');
}
function hideEvidence() { popover.hidden = true; document.querySelectorAll('.cite.on').forEach(c => c.classList.remove('on')); }

function dropdownHTML(id, options, value) {
  const current = options.find(o => String(o.value) === String(value)) || options[0];
  return `<div class="dd" data-dd="${id}"><button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false"><span>${esc(current.label)}</span><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button>
    <div class="dd-menu" role="listbox" hidden>${options.map(o => `<button type="button" role="option" data-value="${esc(o.value)}" aria-selected="${String(o.value) === String(current.value)}"><span>${esc(o.label)}</span>${ICON.check}</button>`).join('')}</div>
    <input type="hidden" id="${id}" value="${esc(current.value)}"></div>`;
}
function closeDropdowns(except) { document.querySelectorAll('.dd.open').forEach(d => { if (d !== except) { d.classList.remove('open'); d.querySelector('.dd-menu').hidden = true; d.querySelector('.dd-btn').setAttribute('aria-expanded', 'false'); } }); }
function openDropdown(dd) {
  closeDropdowns(dd);
  const btn = dd.querySelector('.dd-btn'), menu = dd.querySelector('.dd-menu');
  dd.classList.add('open'); menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect(), h = menu.offsetHeight;
  menu.style.minWidth = r.width + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (r.bottom + 6 + h > window.innerHeight - 8 ? r.top - 6 - h : r.bottom + 6) + 'px';
  (menu.querySelector('[aria-selected="true"]') || menu.querySelector('[role=option]')).focus();
}
function pickDropdown(option) {
  const dd = option.closest('.dd');
  dd.querySelector('input').value = option.dataset.value;
  dd.querySelector('.dd-btn span').textContent = option.querySelector('span').textContent;
  dd.querySelectorAll('[role=option]').forEach(o => o.setAttribute('aria-selected', String(o === option)));
  closeDropdowns(); dd.querySelector('.dd-btn').focus();
}
document.addEventListener('click', e => {
  const option = e.target.closest('.dd [role=option]');
  if (option) return pickDropdown(option);
  const btn = e.target.closest('.dd-btn');
  if (btn) { const dd = btn.closest('.dd'); return dd.classList.contains('open') ? closeDropdowns() : openDropdown(dd); }
  if (!e.target.closest('.dd-menu')) closeDropdowns();
}, true);
document.addEventListener('keydown', e => {
  const dd = e.target.closest?.('.dd');
  if (!dd) return;
  const options = [...dd.querySelectorAll('[role=option]')], at = options.indexOf(document.activeElement);
  if (e.target.matches('.dd-btn') && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); return openDropdown(dd); }
  if (at < 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); options[(at + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus(); }
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeDropdowns(); dd.querySelector('.dd-btn').focus(); }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickDropdown(options[at]); }
}, true);

let settingsTimer = null;
async function openSettings() {
  await refresh();
  const dlg = $('#settings');
  const pending = {}, removeKeys = new Set();
  const draw = () => {
    const c = state.config, h = state.health;
    const dl = h.download;
    const pct = dl?.total ? Math.round(100 * dl.received / dl.total) : 0;
    const missing = h.missing || [];
    const native = h.nativeContext || 262144;
    const contexts = [{ value: 'max', label: `Maximum · ${ktok(native)}` }, ...(h.contextSteps || [8192, 16384, 32768, 65536, 131072]).filter(n => n < native).reverse().map(n => ({ value: n, label: ktok(n) }))];
    const contextNow = pending.context ?? (c.context === 'max' || Number(c.context) >= native ? 'max' : c.context);
    const device = /GPU/.test(h.backend || '') ? 'GPU' : /CPU/.test(h.backend || '') ? 'CPU' : '';
    dlg.innerHTML = `<div class="modal-head"><h3>Settings</h3><button class="btn-icon" value="close" id="closeSettings">${ICON.x}</button></div>
      <div class="modal-body">
        <div class="model-card"><img class="mark" src="logo-96.png" alt=""><b>${esc(h.model || 'Qwen3.5-0.8B')} <span class="badge ${h.llm === 'ready' ? 'ok' : missing.length ? 'bad' : 'warn'}">${h.llm === 'ready' ? 'running' : missing.length ? 'not installed' : esc(h.llm || '')}</span></b>
          <span class="sub">Q4_K_M · 532 MB${device ? ' · ' + device : ''}</span>
          <div class="control">${missing.length || dl ? `<button class="btn primary" id="download" ${dl && !dl.error ? 'disabled' : ''}>${ICON.download}${dl && !dl.error ? 'Downloading…' : `Download ${missing.join(' + ')}`}</button>` : ''}</div>
          ${dl ? `<div class="dl">${dl.error ? `<span style="color:var(--bad)">${esc(dl.error)}</span>` : `${esc(dl.label)} — ${(dl.received / 1e6).toFixed(0)} of ${dl.total ? (dl.total / 1e6).toFixed(0) : '?'} MB<div class="bar"><span style="width:${pct}%"></span></div>`}</div>` : ''}</div>
        <div class="setting"><span class="label">Context window</span><div class="control">${dropdownHTML('cfgContext', contexts, contextNow)}</div></div>
        <div class="setting"><span class="label">Approvals</span><div class="control">${dropdownHTML('cfgApprovals', [{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Full access' }], pending.approvals ?? (c.approvals === 'auto' ? 'auto' : 'ask'))}</div></div>
        <div class="setting"><span class="label">Theme</span><div class="control">${dropdownHTML('cfgTheme', [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], pending.theme ?? store.get('theme', 'system'))}</div></div>
        <div class="setting keys"><span class="label">Search API keys <span class="opt">optional</span></span>
          ${['brave', 'tavily', 'serper'].map(k => { const saved = c.searchKeys?.[k] && !removeKeys.has(k); const s = state.searchProviders?.[k]; return `<div class="keyrow"><span>${{ brave: 'Brave Search', tavily: 'Tavily', serper: 'Serper' }[k]}${saved && s && s !== 'ok' ? ` <span class="badge warn">${esc(s)}</span>` : ''}</span><input type="password" id="key-${k}" placeholder="${saved ? 'Saved · paste to replace' : 'Paste key'}" autocomplete="off" spellcheck="false">${saved ? `<button type="button" class="btn" data-remove-key="${k}">Remove</button>` : '<span></span>'}</div>`; }).join('')}</div>
      </div>
      <div class="modal-foot"><button class="btn" id="cancelSettings">Close</button><button class="btn primary" id="saveSettings">Apply</button></div>`;
  };
  draw();
  dlg.showModal();
  clearInterval(settingsTimer);
  const remember = () => { for (const [k, id] of [['context', 'cfgContext'], ['approvals', 'cfgApprovals'], ['theme', 'cfgTheme']]) if ($('#' + id)) pending[k] = $('#' + id).value; };
  settingsTimer = setInterval(async () => { if (!dlg.open) return clearInterval(settingsTimer); if ((state.health.download || state.health.llm !== 'ready') && !document.querySelector('.dd.open')) { await refresh(); remember(); draw(); } }, 1000);
  dlg.onclose = closeDropdowns;
  dlg.onclick = async e => {
    if (e.target.closest('[data-remove-key]')) { removeKeys.add(e.target.closest('[data-remove-key]').dataset.removeKey); remember(); draw(); return; }
    if (e.target.closest('#download')) { await api('/api/download', {}).catch(err => toast(err.message)); setTimeout(refresh, 400); return; }
    if (e.target.closest('#closeSettings') || e.target.closest('#cancelSettings')) { dlg.close(); return; }
    if (e.target.closest('#saveSettings')) {
      const theme = $('#cfgTheme').value; store.set('theme', theme); applyTheme();
      const searchKeys = Object.fromEntries(['brave', 'tavily', 'serper'].map(k => [k, removeKeys.has(k) && !$('#key-' + k).value.trim() ? '-' : $('#key-' + k).value]));
      const changes = { context: $('#cfgContext').value === 'max' ? 'max' : Number($('#cfgContext').value), approvals: $('#cfgApprovals').value, searchKeys };
      const res = await api('/api/config', changes).catch(err => ({ error: err.message }));
      dlg.close();
      toast(res.error || (res.restarting ? 'Restarting the language model with the new settings…' : 'Saved.'));
      poll();
    }
  };
}
function applyTheme() { const t = store.get('theme', 'system'); if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }

function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 240) + 'px'; syncComposer(); }
input.addEventListener('input', autosize);
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });
$('#composer').addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
$('#stop').addEventListener('click', () => api('/api/stop', { taskId: [...live.keys()][0] }).catch(() => {}));
$('#newChat').addEventListener('click', () => { location.hash = ''; openThread(null); app.classList.remove('rail-open'); input.focus(); });
$('#collapse').addEventListener('click', () => { app.classList.add('rail-collapsed'); app.classList.remove('rail-open'); store.set('rail', false); });
$('#expand').addEventListener('click', () => { app.classList.remove('rail-collapsed'); app.classList.toggle('rail-open'); store.set('rail', true); });
$('#toggleInspector').addEventListener('click', () => toggleInspector());
$('#openSettings').addEventListener('click', openSettings);
$('#modelPill').addEventListener('click', openSettings);
$('#threadSearch').addEventListener('input', renderRail);
view.addEventListener('scroll', () => { following = view.scrollHeight - view.scrollTop - view.clientHeight < 80; });
view.addEventListener('input', e => { if (e.target.id === 'toolFilter') { toolFilter = e.target.value; const pos = e.target.selectionStart; view.innerHTML = toolsHTML(); const f = $('#toolFilter'); f.focus(); f.setSelectionRange(pos, pos); } });
function toggleInspector() { const narrow = matchMedia('(max-width: 1180px)').matches; if (narrow) panes.classList.toggle('force-inspector'); else { panes.classList.toggle('no-inspector'); store.set('inspector', !panes.classList.contains('no-inspector')); } $('#toggleInspector').classList.toggle('on', !panes.classList.contains('no-inspector')); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && (deleteArmed || clearArmed)) { clearTimeout(armTimer); deleteArmed = null; clearArmed = false; renderRail(); }
  if (e.key === 'Escape') { hideEvidence(); if (live.size) api('/api/stop', {}).catch(() => {}); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#newChat').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); toggleInspector(); }
});
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-clear-all],[data-delete-confirm],[data-ask],[data-thread],[data-delete],[data-view],[data-inspect],[data-caught],[data-approve],[data-tab],.cite,[data-select]');
  if (!el) { if (!e.target.closest('.popover')) hideEvidence(); return; }
  if (el.matches('.cite')) { e.preventDefault(); e.stopPropagation(); return popover.hidden || !el.classList.contains('on') ? showEvidence(el) : hideEvidence(); }
  if (el.dataset.approve) { const [taskId, id, yes] = el.dataset.approve.split(':'); el.closest('.approve-actions').innerHTML = '<span class="sub">Sending…</span>'; await api('/api/approve', { taskId, id, approve: yes === '1' }).catch(err => toast(err.message)); return; }
  if (el.matches('[data-clear-all]')) {
    if (!clearArmed) return arm('all');
    clearTimeout(armTimer); clearArmed = false;
    const r = await api('/api/threads', {}, 'DELETE').catch(err => { toast(err.message); return null; });
    if (r) { toast(`Deleted ${r.removed} chat${r.removed === 1 ? '' : 's'} from this computer`); if (!thread || !thread.turns.some(x => live.has(x.id))) { location.hash = ''; threadId = null; thread = null; } }
    await refresh(); return render();
  }
  if (el.dataset.delete) { e.stopPropagation(); return arm('one', el.dataset.delete); }
  if (el.dataset.deleteConfirm) {
    e.stopPropagation(); clearTimeout(armTimer); deleteArmed = null;
    const id = el.dataset.deleteConfirm;
    await api('/api/thread/' + id, {}, 'DELETE').catch(err => toast(err.message));
    if (id === threadId) { location.hash = ''; threadId = null; thread = null; }
    await refresh(); return render();
  }
  if (el.dataset.ask) { if (page !== 'chat') { location.hash = ''; threadId = null; thread = null; } return ask(el.dataset.ask); }
  if (el.dataset.thread) { location.hash = '#/t/' + el.dataset.thread; app.classList.remove('rail-open'); return; }
  if (el.dataset.view) { location.hash = '#/' + el.dataset.view; app.classList.remove('rail-open'); return; }
  if (el.dataset.tab) { inspectorTab = el.dataset.tab; return renderInspector(); }
  if (el.dataset.inspect) { const [id, tab] = el.dataset.inspect.split(':'); selectedTurn = id; inspectorTab = tab; if (panes.classList.contains('no-inspector') || matchMedia('(max-width: 1180px)').matches) toggleInspector(); return renderInspector(); }
  if (el.dataset.caught) { caughtOpen.has(el.dataset.caught) ? caughtOpen.delete(el.dataset.caught) : caughtOpen.add(el.dataset.caught); following = false; return render(); }
  if (el.dataset.select && !e.target.closest('a,button')) { selectedTurn = el.dataset.select; renderInspector(); }
});
document.addEventListener('mouseover', e => { const c = e.target.closest('.cite'); if (c && matchMedia('(hover: hover)').matches) showEvidence(c); });
document.addEventListener('mouseout', e => { const c = e.target.closest('.cite'); if (c && !e.relatedTarget?.closest?.('.popover') && matchMedia('(hover: hover)').matches) setTimeout(() => { if (!popover.matches(':hover')) hideEvidence(); }, 120); });
popover.addEventListener('mouseleave', hideEvidence);

function route() {
  const m = location.hash.match(/^#\/t\/(\w+)/);
  if (m) return openThread(m[1]);
  const v = location.hash.match(/^#\/(tools|trust|about)/);
  if (v) { page = v[1]; return render(); }
  page = 'chat';
  if (!live.size || !thread) { threadId = null; thread = null; }
  render();
}
window.addEventListener('hashchange', route);
function poll() {
  clearTimeout(poll.timer);
  refresh().then(() => {
    const h = state.health;
    if (page === 'chat' && !thread && !view.querySelector('.home')) view.innerHTML = homeHTML();
    poll.timer = setTimeout(poll, h.llm === 'ready' && h.reflex === 'ready' ? 15000 : 1500);
  });
}
applyTheme();
if (store.get('rail', true) === false) app.classList.add('rail-collapsed');
if (store.get('inspector', true) === false) panes.classList.add('no-inspector');
$('#toggleInspector').classList.toggle('on', !panes.classList.contains('no-inspector'));
poll();
route();
input.focus();
