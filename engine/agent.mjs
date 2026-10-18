import * as mouth from './mouth.mjs';
import * as reflex from './reflex.mjs';
import { agentTools, agentById } from './tools/index.mjs';
import * as P from './os/platform.mjs';
import { factsPrompt } from './compose.mjs';
import { parseBlocks, indexEvidence, checkSentence, summarize } from './verify.mjs';
import { intentOf, planSave, planEdit, writeEdit, verifyFile, latestText, FILE_GOAL } from './actions.mjs';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { words } from './util.mjs';
import { compile as compileWeb, interpret as interpretWeb, runOp, TOOL_OF, begin as beginWeb } from './webtask.mjs';

const MAX_STEPS = 8;

async function context() {
  return `Computer: ${P.OS_NAME}, shell ${P.SHELL_NAME}. Write file paths starting with the folder name: desktop/…, documents/…, downloads/…, pictures/…, music/…, videos/…, home/…, or workspace/… for new files you make (for example desktop/notes.txt or workspace/report.docx). Today is ${new Date().toDateString()}.`;
}

const PLAN_EXAMPLES = [
  ['Save a summary of the top technology news today to a text file on my desktop', ['Search the web for the top technology news today', 'Write a short summary of those headlines', 'Save the summary as tech-news.txt on the desktop']],
  ['How much free space is left on my drives?', ['Check the free space on every drive']],
  ['Open YouTube and search for lofi music', ['Open https://www.youtube.com in the browser', 'Type lofi music into the search box and press Enter']],
  ['Zip the Taxes folder in my documents and put the zip on my desktop', ['Create a zip archive of Documents/Taxes saved as Desktop/Taxes.zip']],
  ['Find all the PDFs in my downloads from this month and list them', ['Find PDF files in the Downloads folder changed in the last 31 days']],
  ['Make a Word document with a shopping list for a barbecue', ['Write a shopping list for a barbecue', 'Save it as a Word document workspace/barbecue-shopping-list.docx']],
  ['Delete the old installer setup.exe from my downloads', ['Delete downloads/setup.exe']],
  ['Make a text file called todo with call mom and buy milk', ['Write the file workspace/todo.txt containing: call mom, buy milk']],
  ['Write a short poem about autumn and save it in C:\\Users\\sam\\Poems', ['Write a short poem about autumn', 'Save the poem in C:\\Users\\sam\\Poems']],
  ['In notes.txt on my desktop replace "Monday" with "Tuesday"', ['Replace "Monday" with "Tuesday" in desktop/notes.txt']]
];
const FILE_REQUEST = /\b(create|make|write|save|start|put)\b\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?(text\s+|txt\s+|plain\s+text\s+|word\s+|pdf\s+)?(file|note|document|doc)\b(?:\s+(?:in|on)\s+(?:my\s+|the\s+)?(desktop|documents|downloads|workspace))?\s+(?:called|named|titled)\s+["“']?([\w .()-]+?)["”']?(?:\s+(?:in|on)\s+(?:my\s+|the\s+)?(desktop|documents|downloads|workspace))?\s+(?:with|containing|that says|saying|listing)\s+(.+?)[.!]?$/i;
function fixedPlan(goal) {
  const m = goal.match(FILE_REQUEST);
  if (!m) return null;
  const [, , kind = '', , where1, rawName, where2, content] = m;
  const folder = (where1 || where2 || 'workspace').toLowerCase();
  const ext = /word|doc/i.test(`${kind} ${m[3]}`) ? '.docx' : /pdf/i.test(kind) ? '.pdf' : '.txt';
  const name = /\.\w{2,4}$/.test(rawName.trim()) ? rawName.trim() : rawName.trim().replace(/\s+/g, '-') + ext;
  return [`Write the file ${folder}/${name} containing: ${content.trim()}`];
}

async function plan(goal, history, signal) {
  if (intentOf(goal) === 'edit') return [goal];
  const fixed = fixedPlan(goal);
  if (fixed) return fixed;
  const messages = [
    { role: 'system', content: `You turn a request into a short plan of concrete steps for an assistant that can use this computer and the web: open apps, websites and folders; read, write, move, copy, zip and find files; run ${P.SHELL_NAME} commands; search and read the web; download files; click, type and read in web pages and app windows; write text such as summaries, emails and documents. 1 to 6 steps, each one action, in plain English. Include names, paths and URLs from the request. A file is not a folder: to make a file with text in it, write the file. Work directly on files, commands and the web: never open an app or a folder just to get to a file — only open things when the user asks to see them. Use as few steps as possible. Output JSON.` },
    ...PLAN_EXAMPLES.flatMap(([q, steps]) => [{ role: 'user', content: q }, { role: 'assistant', content: JSON.stringify({ steps }) }]),
    ...(history.length ? [{ role: 'user', content: `(Earlier in this conversation: ${history.slice(-2).map(h => h.question).join(' / ')})` }, { role: 'assistant', content: '{"steps":["(noted)"]}' }] : []),
    { role: 'user', content: goal }
  ];
  const result = await mouth.json(messages, { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 } }, required: ['steps'] }, { maxTokens: 260, signal });
  const steps = (result?.steps || []).map(s => String(s).trim()).filter(s => s.length > 3 && !/^\(noted\)$/.test(s));
  return steps.length ? steps.slice(0, 6) : [goal];
}

async function pickTool(step, goal, previous, signal) {
  const ranked = await rankFor(step);
  const [best, second] = ranked;
  if (best.sim - (second?.sim || 0) >= 0.05 && best.sim >= 0.72) return { tool: agentById[best.id], by: 'reflex', ranked };
  const options = ranked.slice(0, 5);
  const choice = await mouth.json([
    { role: 'system', content: 'Choose the one tool that does this step. Output JSON.' },
    { role: 'user', content: `Request: ${goal}\nStep: ${step}\n${previous ? `Just before: ${previous}\n` : ''}Tools:\n${options.map(o => `- ${o.id}: ${agentById[o.id].description.split(/(?<=\.)\s/)[0]}`).join('\n')}` }
  ], { type: 'object', properties: { tool: { enum: options.map(o => o.id) } }, required: ['tool'] }, { maxTokens: 30, signal });
  return { tool: agentById[choice?.tool || best.id], by: 'model', ranked };
}
let toolVectors = null;
async function rankFor(text) {
  if (!toolVectors) {
    const rows = agentTools.flatMap(t => [`${t.id.replace(/_/g, ' ')}: ${t.description.split(/(?<=\.)\s/)[0]}`, ...(t.examples || []).slice(0, 4)].map(textOf => ({ id: t.id, text: textOf })));
    const vectors = await reflex.embed(rows.map(r => r.text));
    toolVectors = rows.map((r, i) => ({ ...r, v: vectors[i] }));
  }
  const [q] = await reflex.embed([text]);
  const best = {};
  for (const row of toolVectors) { const sim = reflex.cosine(q, row.v); if (!best[row.id] || sim > best[row.id]) best[row.id] = sim; }
  return Object.entries(best).map(([id, sim]) => ({ id, sim })).sort((a, b) => b.sim - a.sim);
}

const NEEDS_REF = { browser_click: 'ref', browser_click_and_wait: 'ref', browser_click_special: 'ref', browser_fill: 'ref', browser_hover: 'ref', upload_file: 'ref' };
const NEEDS_NAME = { click_element: 'name', type_text: 'into' };
async function bestElement(step, elements, wantTypeable) {
  const pool = elements.filter(e => (e.name || e.value) && (!wantTypeable || /text|search|email|password|textarea|textbox|combobox|searchbox|edit|entry|input|url|tel|number|AXTextField/i.test(e.role || e.type)));
  const list = pool.length ? pool : elements.filter(e => e.name);
  if (!list.length) return null;
  const scores = await reflex.rerank(step, list.map(e => `${e.role || e.type || ''} ${e.name || ''} ${e.value || ''}`.trim()));
  let best = 0;
  scores.forEach((s, i) => { if (s.logit > scores[best].logit) best = i; });
  return list[best];
}

function flatten(value, depth = 0) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.slice(0, 40).map(v => (typeof v === 'object' ? flatten(v, depth + 1) : String(v))).join(depth ? '; ' : '\n');
  return Object.entries(value).filter(([, v]) => v !== '' && v != null).map(([k, v]) => typeof v === 'object' ? `${k}:${Array.isArray(v) ? '\n' : ' '}${flatten(v, depth + 1)}` : `${k}: ${v}`).join(depth ? ', ' : '\n');
}
const brief = (text, n = 900) => text.length > n ? text.slice(0, n) + ' …' : text;
function substitute(args, results) {
  const json = JSON.stringify(args).replace(/\{\{\s*(?:step\s*)?(\d+|last)\s*\}\}/gi, (m, n) => {
    const r = n === 'last' ? results.at(-1) : results[Number(n) - 1];
    return r ? JSON.stringify(r.text || r.output).slice(1, -1) : m;
  });
  return JSON.parse(json);
}

async function fillArgs(tool, step, goal, results, error, signal) {
  const earlier = results.map((r, i) => `[step ${i + 1}] ${r.step} → ${r.ok ? brief(r.output, 700) : 'FAILED: ' + r.error}`).join('\n');
  const schema = JSON.parse(JSON.stringify(tool.parameters || { type: 'object', properties: {} }));
  for (const prop of Object.values(schema.properties || {})) if (!prop.type && !prop.enum) prop.type = 'string';
  const filled = await mouth.json([
    { role: 'system', content: `You fill in the arguments for one tool call so that it does the current step. ${await context()} Use exact paths, names and URLs. To pass the full output of an earlier step, write {{step N}}. Output JSON only.` },
    { role: 'user', content: `Request: ${goal}\nCurrent step: ${step}\nTool: ${tool.id} — ${tool.description.slice(0, 600)}\n${earlier ? `Earlier steps:\n${earlier}\n` : ''}${error ? `The last attempt failed: ${error}. Fix the arguments.\n` : ''}Arguments:` }
  ], schema, { maxTokens: tool.id === 'write_file' || tool.id === 'write_document' ? 900 : 300, signal });
  return filled || {};
}

export async function act(task, { emit = () => {}, signal, confirm, history = [] }) {
  const goal = task.prompt;
  const t0 = performance.now();
  emit({ type: 'stage', stage: 'plan' });
  const web = await compileWeb(goal).catch(() => null);
  beginWeb();
  let steps = web ? web.map(o => o.step) : await plan(goal, history, signal);
  emit({ type: 'plan', steps });

  const results = [];
  let lastRead = null;
  const finish = (i, step, record) => {
    results.push(record);
    emit({ type: 'step', index: i, step, status: record.ok ? 'done' : record.declined ? 'declined' : record.refused ? 'refused' : 'failed', tool: record.tool, title: agentById[record.tool]?.title || record.tool, args: redact(record.args), output: brief(record.output || '', 1500), error: record.error });
  };
  const allowed = async (tool, args, step) => {
    const risk = typeof tool.risk === 'function' ? await tool.risk(args) : tool.risk;
    if (risk === 'never') return { ok: false, refused: true, error: 'refused: this could damage the system or delete data for good' };
    if (risk === 'change' && !(confirm && await confirm({ title: tool.describe ? tool.describe(args) : tool.title, tool: tool.id, args: redact(args), detail: step }))) return { ok: false, declined: true, error: 'you declined this step' };
    return { ok: true };
  };
  const action = async (kind, step, i) => {
    if (kind === 'save') {
      const plan = await planSave(step, goal, results);
      if (plan.error) return { step, tool: 'write_file', args: {}, ok: false, error: plan.error };
      const tool = /\.(docx|pdf|xlsx)$/i.test(plan.file) ? agentById.write_document : agentById.write_file;
      const args = tool.id === 'write_document' ? { path: plan.file, title: plan.title, content: plan.content } : { path: plan.file, content: plan.content };
      emit({ type: 'step', index: i, step, status: 'running', tool: tool.id, title: tool.title, args: redact(args), by: 'rules' });
      const gate = await allowed(tool, args, step);
      if (!gate.ok) return { step, tool: tool.id, args, ...gate };
      try {
        fs.mkdirSync(dirname(plan.file), { recursive: true });
        await tool.run(args, { goal, step, results, signal });
      } catch (e) { return { step, tool: tool.id, args, ok: false, error: e.message }; }
      const check = verifyFile(plan.file, plan.content);
      return check.ok ? { step, tool: tool.id, args, ok: true, verifiedFile: plan.file, content: plan.content, output: `Saved ${plan.file} (${check.bytes} bytes, checked on disk)${plan.note ? `; ${plan.note}` : ''}.` } : { step, tool: tool.id, args, ok: false, error: check.why };
    }
    if (kind === 'edit') {
      const readText = async file => String((await agentById.read_file.run({ path: file }))?.text || '');
      const plan = await planEdit(step, goal, readText, signal).catch(e => ({ error: e.message }));
      if (plan.error) return { step, tool: 'edit_file', args: {}, ok: false, error: plan.error };
      const args = { path: plan.file, change: plan.how };
      emit({ type: 'step', index: i, step, status: 'running', tool: 'edit_file', title: 'Edit file', args, by: 'rules' });
      const gate = await allowed(agentById.edit_file, { path: plan.file }, step);
      if (!gate.ok) return { step, tool: 'edit_file', args, ...gate };
      let saved;
      try { saved = await writeEdit(plan.file, plan.after, a => agentById.write_document.run(a, {})); } catch (e) { return { step, tool: 'edit_file', args, ok: false, error: e.message }; }
      const check = verifyFile(plan.file, /\.(docx|pdf|xlsx)$/i.test(plan.file) ? null : plan.after);
      return check.ok ? { step, tool: 'edit_file', args, ok: true, verifiedFile: plan.file, edited: true, output: `Edited ${plan.file}: ${plan.how}. The previous version was kept at ${saved}.` } : { step, tool: 'edit_file', args, ok: false, error: check.why };
    }
    if (kind === 'mkdir') {
      const raw = step.match(/[A-Za-z]:\\[^"<>|?*\n]*|(?:desktop|documents|downloads|workspace)[\\/][^\s"]+/i)?.[0] || step.match(/\b(?:called|named)\s+["“']?([^"”'.,]+)/i)?.[1] || 'new folder';
      const path = await P.resolvePath(raw.trim());
      const tool = agentById.make_directory, args = { path };
      emit({ type: 'step', index: i, step, status: 'running', tool: tool.id, title: tool.title, args, by: 'rules' });
      const gate = await allowed(tool, args, step);
      if (!gate.ok) return { step, tool: tool.id, args, ...gate };
      try { await tool.run(args, {}); } catch (e) { return { step, tool: tool.id, args, ok: false, error: e.message }; }
      return fs.existsSync(path) && fs.statSync(path).isDirectory() ? { step, tool: tool.id, args, ok: true, verifiedFile: path, output: `Created the folder ${path} (checked on disk).` } : { step, tool: tool.id, args, ok: false, error: `${path} was not created` };
    }
    return null;
  };
  const webStep = async (op, step, i) => {
    const toolId = TOOL_OF[op.op], tool = agentById[toolId];
    const { step: _s, op: _o, ...args } = op;
    emit({ type: 'step', index: i, step, status: 'running', tool: toolId, title: tool?.title || toolId, args, by: 'rules' });
    if (tool) { const gate = await allowed(tool, args, step); if (!gate.ok) return { step, tool: toolId, args, browser: true, ...gate }; }
    try {
      const r = await runOp(op);
      const output = [r.report.replace(/\*\*/g, ''), ...(r.items || []).map((t, n) => `${n + 1}. ${t}`), ...(r.notes ? [`(tried first: ${r.notes})`] : [])].join('\n');
      return { step, tool: toolId, args, ok: true, browser: true, report: r.report, items: r.items, output, text: output, raw: r };
    } catch (e) { return { step, tool: toolId, args, ok: false, browser: true, error: e.message }; }
  };
  const runSteps = async (from) => {
  for (let i = from; i < steps.length && i < MAX_STEPS; i++) {
    if (signal?.aborted) throw new Error('stopped');
    const step = steps[i];
    emit({ type: 'step', index: i, step, status: 'choosing' });
    const op = web?.[i] || interpretWeb(step, { browser: results.some(r => r?.browser && r.ok) });
    if (op) { const record = await webStep(op, step, i); finish(i, step, record); if (record.declined || record.refused) return 'stopped'; continue; }
    const kind = intentOf(step);
    if (kind) {
      const record = await action(kind, step, i);
      if (record) { finish(i, step, record); if (!record.ok && (record.declined || record.refused)) return 'stopped'; continue; }
    }
    const { tool, by, ranked } = await pickTool(step, goal, results.at(-1) && `${results.at(-1).step} → ${brief(results.at(-1).output || results.at(-1).error || '', 200)}`, signal);

    if ((NEEDS_REF[tool.id] || tool.id === 'browser_press' || tool.id === 'browser_fill_form') && lastRead?.kind !== 'page') {
      const page = await agentById.browser_read.run({}).catch(() => null);
      if (page) lastRead = { kind: 'page', elements: page.elements };
    }
    if (NEEDS_NAME[tool.id] && lastRead?.kind !== 'screen') {
      const screen = await agentById.read_screen.run({}).catch(() => null);
      if (screen) lastRead = { kind: 'screen', elements: screen.controls };
    }

    let attempt = 0, error = null, record = null;
    while (attempt < 2 && !record) {
      attempt++;
      let args = await fillArgs(tool, step, goal, results, error, signal);
      args = substitute(args, results);
      if (NEEDS_REF[tool.id] && lastRead?.kind === 'page') {
        const el = await bestElement(step, lastRead.elements, tool.id === 'browser_fill');
        if (el) args[NEEDS_REF[tool.id]] = el.ref;
      }
      if (tool.id === 'browser_press' && lastRead?.kind === 'page' && /\b(in|into|on)\b/.test(step)) { const el = await bestElement(step, lastRead.elements, true); if (el) args.ref = el.ref; }
      if (NEEDS_NAME[tool.id] && lastRead?.kind === 'screen' && lastRead.elements?.length) {
        const el = await bestElement(step, lastRead.elements, tool.id === 'type_text');
        if (el && (tool.id === 'click_element' || args.into)) args[NEEDS_NAME[tool.id]] = el.name;
      }
      emit({ type: 'step', index: i, step, status: 'running', tool: tool.id, title: tool.title, args: redact(args), by });

      const problem = await precheck(tool.id, args);
      if (problem) { error = problem; if (attempt >= 2) record = { step, tool: tool.id, args, ok: false, error: problem }; continue; }
      const risk = typeof tool.risk === 'function' ? await tool.risk(args) : tool.risk;
      const what = tool.describe ? tool.describe(args) : `${tool.title}: ${JSON.stringify(args).slice(0, 200)}`;
      if (risk === 'never') { record = { step, tool: tool.id, args, ok: false, error: 'refused: this could damage the system or delete data for good', refused: true }; break; }
      if (risk === 'change') {
        const approved = confirm ? await confirm({ title: what, tool: tool.id, args: redact(args), detail: step }) : false;
        if (!approved) { record = { step, tool: tool.id, args, ok: false, error: 'you declined this step', declined: true }; break; }
      }
      try {
        const output = await tool.run(args, { goal, step, results, signal, confirm });
        const named = tool.id === 'write_text' && typeof output?.text === 'string' && step.match(/[\w()-]+(?:\.[\w()-]+)*\.(txt|md|csv|json|html|docx|pdf)\b/i);
        if (named) {
          const plan = await planSave(step, goal, [{ ok: true, text: output.text }]);
          if (!plan.error) {
            const saver = /\.(docx|pdf|xlsx)$/i.test(plan.file) ? agentById.write_document : agentById.write_file;
            const saveArgs = saver.id === 'write_document' ? { path: plan.file, title: plan.title, content: plan.content } : { path: plan.file, content: plan.content };
            const gate = await allowed(saver, saveArgs, step);
            if (gate.ok) { fs.mkdirSync(dirname(plan.file), { recursive: true }); await saver.run(saveArgs, {}); if (verifyFile(plan.file, plan.content).ok) output.savedTo = plan.file; }
          }
        }
        const text = typeof output?.text === 'string' && tool.id === 'write_text' ? output.text : flatten(output);
        record = { step, tool: tool.id, args, ok: true, content: output?.savedTo ? output.text : undefined, output: text + (output?.savedTo ? `\nSaved ${output.savedTo} (checked on disk).` : ''), text: output?.text, raw: output, risk, verifiedFile: output?.savedTo || null };
        if (/^(browser_read|open_page|browser_click|browser_click_and_wait|browser_press|browser_back)$/.test(tool.id)) lastRead = output?.elements ? { kind: 'page', elements: output.elements } : (tool.id === 'browser_read' ? lastRead : null);
        if (tool.id === 'read_screen') lastRead = { kind: 'screen', elements: output.controls };
        if (/^(click_element|type_text|press_key|focus_window|open_app)$/.test(tool.id)) lastRead = null;
      } catch (e) {
        error = e.message;
        if (attempt >= 2) record = { step, tool: tool.id, args, ok: false, error: e.message };
      }
    }
    results.push(record);
    emit({ type: 'step', index: i, step, status: record.ok ? 'done' : record.declined ? 'declined' : record.refused ? 'refused' : 'failed', tool: tool.id, title: tool.title, args: redact(record.args), output: brief(record.output || '', 1500), error: record.error, media: record.raw?.media || null });
    if (!record.ok && (record.declined || record.refused)) return 'stopped';
  }
  return 'done';
  };

  let outcome = await runSteps(0);
  if (outcome === 'done' && !results.some(r => r?.browser)) {
    const check = await answered(goal, results);
    emit({ type: 'check', ...check });
    const missingTarget = results.every(r => r.ok || /does not exist\b|^there is no folder/.test(r.error || ''));
    if (!check.ok && !missingTarget && steps.length < MAX_STEPS) {
      const tried = results.map(r => `${r.step} (${r.tool}) → ${r.ok ? brief(r.output, 200) : 'failed: ' + r.error}`).join('; ');
      const more = await plan(`${goal}
(Already tried, and it did not answer the request: ${tried}. Plan different steps that will.)`, history, signal);
      const start = steps.length;
      steps = [...steps, ...more].slice(0, MAX_STEPS);
      emit({ type: 'plan', steps, replanned: true });
      outcome = await runSteps(start);
    }
  }

  if (outcome !== 'stopped' && FILE_GOAL.test(goal) && !results.some(r => r.verifiedFile) && latestText(results)) {
    const step = 'Save the result where the request asked';
    steps = [...steps, step];
    emit({ type: 'plan', steps, replanned: true });
    const record = await action('save', goal, steps.length - 1);
    if (record) finish(steps.length - 1, step, { ...record, step });
  }

  const confirmed = results.filter(r => r.ok && (r.verifiedFile || r.report));
  const proven = results.length && results.every(r => (r.ok && (r.verifiedFile || r.report)) || (r.browser && !r.ok));
  if (proven || (confirmed.length && !results.some(r => r.browser) && results.every(r => r.ok))) {
    const blocks = [];
    for (const r of results) {
      if (r.report || (r.browser && !r.ok)) {
        blocks.push({ type: 'paragraph', sentences: [{ text: r.ok ? r.report : `**Could not ${r.step[0].toLowerCase() + r.step.slice(1)}:** ${r.error}.`, status: r.ok ? 'supported' : 'meta', cites: [] }] });
        for (const item of r.items || []) blocks.push({ type: 'item', ordered: true, depth: 0, sentences: [{ text: item, status: 'meta' }] });
        continue;
      }
      if (!r.verifiedFile) continue;
      blocks.push({ type: 'paragraph', sentences: [{ text: `**${r.edited ? 'Edited' : /^Created the folder/.test(r.output) ? 'Created' : 'Saved'}:** \`${r.verifiedFile}\``, status: 'supported', cites: [] }] });
      if (r.edited) blocks.push({ type: 'paragraph', sentences: [{ text: `${r.args?.change ? r.args.change[0].toUpperCase() + r.args.change.slice(1) : 'Changed as asked'}. The previous version is kept in case you want it back.`, status: 'meta' }] });
      const body = r.content || r.text;
      if (!r.edited && body && body.length < 4000) for (const para of body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)) blocks.push({ type: 'paragraph', sentences: [{ text: para, status: 'meta' }] });
    }
    const NLc = '\n';
    const answer = blocks.map(b => b.sentences.map(s => s.text).join(' ')).join(NLc + NLc);
    emit({ type: 'token', text: answer });
    return { mode: 'act', question: goal, steps: results.map(r => ({ step: r.step, tool: r.tool, ok: r.ok, output: brief(r.output || '', 1500), args: redact(r.args) })), answer, blocks, stats: null, removed: [], evidence: [], timings: { total: Math.round(performance.now() - t0) } };
  }

  emit({ type: 'stage', stage: 'speak' });
  const facts = results.flatMap((r, i) => r.ok ? [{ text: `Step ${i + 1} (${r.step}) done with ${r.tool}. Result: ${brief(r.output, 1200)}` }] : [{ text: `Step ${i + 1} (${r.step}) did not happen: ${r.error}.` }]);
  const prompt = factsPrompt({ question: goal, intent: 'act', facts, vote: null, history: [] });
  const { text } = await mouth.say(prompt, { maxTokens: 450, temperature: 0.2, signal, onToken: piece => emit({ type: 'token', text: piece }) });
  emit({ type: 'stage', stage: 'verify' });
  const evidence = results.map((r, i) => ({ id: i + 1, text: r.ok ? `${r.step}. ${brief(r.output, 3000)}` : `${r.step} did not happen: ${r.error}`, site: r.tool, host: r.tool, tool: r.tool }));
  const blocks = parseBlocks(text.trim());
  if (evidence.length) {
    const index = await indexEvidence(evidence);
    await Promise.all(blocks.flatMap(b => (b.sentences || []).map(s => checkSentence(s.text, index, { question: goal, mode: 'grounding' }).then(r => Object.assign(s, r)))));
  }
  const verified = summarize(blocks);
  for (const b of verified.blocks) if (b.sentences) b.sentences = b.sentences.filter(s => s.status !== 'contradicted' && s.status !== 'ungrounded');
  const files = results.filter(r => r.ok && r.verifiedFile);
  const asked = new Set(words(goal));
  for (const b of verified.blocks) if (b.sentences) b.sentences = b.sentences.filter(s => {
    const w = words(s.text);
    if (w.length && w.filter(x => asked.has(x)).length / w.length >= 0.7) return false;
    if (/:\s*$/.test(s.text)) return false;
    if (!files.length && /\b(saved|created|stored|written|wrote)\b/i.test(s.text)) return false;
    return true;
  });
  verified.blocks = verified.blocks.filter(b => !b.sentences || b.sentences.length);
  if (files.length) {
    const shown = [];
    for (const r of files) {
      shown.push({ type: 'paragraph', sentences: [{ text: `**${r.edited ? 'Edited' : /^Created the folder/.test(r.output) ? 'Created' : 'Saved'}:** \`${r.verifiedFile}\``, status: 'supported', cites: [] }] });
      const body = r.content || r.text;
      if (body && body.length < 4000) for (const para of body.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)) shown.push({ type: 'paragraph', sentences: [{ text: para, status: 'meta' }] });
    }
    verified.blocks.unshift(...shown);
  }
  const NL = '\n';
  const answer = verified.blocks.map(b => b.type === 'item' ? '- ' + b.sentences.map(s => s.text).join(' ')
    : b.type === 'heading' ? '### ' + b.text
    : b.type === 'code' ? '```' + NL + b.text + '```'
    : b.type === 'table' ? b.rows.join(NL)
    : (b.sentences || []).map(s => s.text).join(' ')).join(NL + NL);
  return { mode: 'act', question: goal, steps: results.map(r => ({ step: r.step, tool: r.tool, ok: r.ok, error: r.error, output: brief(r.output || '', 1500), args: redact(r.args), declined: r.declined, refused: r.refused, media: r.raw?.media || null })), answer, blocks: verified.blocks, stats: verified.stats, removed: verified.removed, evidence: evidence.map(e => ({ ...e, text: brief(e.text, 1500) })), timings: { total: Math.round(performance.now() - t0) } };
}

const EXISTING = { delete_file: 'path', move_file: 'source', copy_file: 'source', edit_file: 'path', read_file: 'path', extract_archive: 'archive', open_with: 'path', list_files: 'path', create_archive: 'source', upload_file: 'path', verify_image: 'path', open_folder: 'path' };
async function precheck(toolId, args) {
  const key = EXISTING[toolId];
  if (!key || !args[key]) return null;
  const { existsSync, readdirSync } = await import('node:fs');
  const { dirname, basename } = await import('node:path');
  const full = await P.resolvePath(args[key]);
  if (existsSync(full)) return null;
  const dir = dirname(full), name = basename(full).toLowerCase();
  let near = [];
  try {
    const entries = readdirSync(dir);
    const stem = name.replace(/\.[^.]+$/, '');
    near = entries.map(e => ({ e, score: e.toLowerCase() === name ? 3 : e.toLowerCase().includes(stem) ? 2 : stem.split(/[\s_-]+/).filter(w => w.length > 2 && e.toLowerCase().includes(w)).length ? 1 : 0 })).filter(x => x.score).sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.e);
    if (!near.length) near = entries.slice(0, 12);
  } catch { return `there is no folder ${dir}`; }
  return `${full} does not exist. ${near.length ? `In ${dir} there is: ${near.join(', ')}` : `${dir} is empty`}.`;
}

async function answered(goal, results) {
  const ok = results.filter(r => r.ok && r.output);
  if (!ok.length) return { ok: false, score: null, why: 'no step succeeded' };
  const scores = await reflex.rerank(goal, ok.map(r => `${r.step}. ${brief(r.output, 1200)}`));
  const best = Math.max(...scores.map(s => s.logit));
  return { ok: best > -1, score: +best.toFixed(2) };
}

function redact(args = {}) {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, /password|token|secret|api[_-]?key/i.test(k) ? '••••' : typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '…' : v]));
}
