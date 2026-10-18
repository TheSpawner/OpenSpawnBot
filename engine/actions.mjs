import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, basename, join, extname } from 'node:path';
import * as mouth from './mouth.mjs';
import * as P from './os/platform.mjs';
import { DATA } from './util.mjs';

const EXT = 'txt|md|markdown|csv|json|html?|css|js|mjs|ts|py|xml|ya?ml|ini|log|rtf|docx|pdf|xlsx';
const DOC = /\.(docx|pdf|xlsx)$/i;
const ALIAS = 'desktop|documents|downloads|workspace|pictures|music|videos|home';

const SAVE = /^\s*(?:then\s+|and\s+|now\s+)?(save|store|put|export|keep|write (?:it|this|that|them|the (?:result|article|summary|text|list|essay|report|email|letter|story|poem|notes?)))\b/i;
const MKDIR = /^\s*(?:then\s+)?(create|make)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:empty\s+)?(folder|directory)\b/i;
const EDIT = /^\s*(?:then\s+)?(edit|change|modify|update|replace|append|add|insert|remove|delete|rewrite|fix|correct|shorten|expand|reword|rephrase|translate)\b/i;
const MODIFY = /\b(put|make|change|replace|add|remove|delete|fix|rewrite|reword|turn|sort|format|capitali[sz]e|number|bullet|indent|shorten|expand|translate|update|insert|append|split|merge|correct|edit|move each|swap)\b/i;
const FILE_NAME = new RegExp(String.raw`["“']([^"”'\n]+\.(?:${EXT}))["”']|([\w()-]+(?:\.[\w()-]+)*\.(?:${EXT}))\b`, 'i');
const FOLDER_WORD = new RegExp(String.raw`\b(?:on|in|into|to|inside|under)\s+(?:my\s+|the\s+)?(${ALIAS})(?:\s+folder)?\b`, 'i');

export const FILE_GOAL = new RegExp(String.raw`\b(save|store|put|export|write|create|make)\b[^.?!]*\b(file|folder|desktop|documents|downloads|workspace|word document|text file|pdf|spreadsheet)\b|\.(?:${EXT})\b|\b[a-z]:\\`, 'i');

function pathCandidates(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z]:\\[^"<>|?*\n]*/g)) out.push(m[0]);
  for (const m of text.matchAll(/(?:^|\s)((?:~|\/(?:Users|home|mnt|tmp|var|opt|Volumes))\/[^"<>|?*\n]*)/g)) out.push(m[1]);
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:${ALIAS})[\\/][^"<>|?*\n\s]*`, 'gi'))) out.push(m[0]);
  return out.map(s => s.replace(/[\s.,;:!?"'”]+$/, '').replace(/\s+(?:as|with|containing|and|then|so)\s.*$/i, '').trim()).filter(Boolean);
}

async function existing(raw) {
  let path = await P.resolvePath(raw);
  const full = path;
  for (let guard = 0; guard < 12 && path.length > 3; guard++) {
    if (fs.existsSync(path)) return { path, exists: true, isDir: fs.statSync(path).isDirectory(), trimmed: path !== full };
    const shorter = path.replace(/[\s([{]+[^\\/\s([{]*[)\]}]?$/, '').replace(/\s+$/, '');
    if (shorter === path) break;
    path = shorter;
  }
  return { path: full, exists: false };
}

export function intentOf(step) {
  if (MKDIR.test(step)) return 'mkdir';
  if (SAVE.test(step) && (pathCandidates(step).length || FILE_NAME.test(step) || FOLDER_WORD.test(step) || /\b(file|folder|document)\b/i.test(step))) return 'save';
  if (/^\s*write\s+(?:the\s+)?file\b/i.test(step) && /containing:/i.test(step)) return 'save';
  if (EDIT.test(step) && (pathCandidates(step).length || FILE_NAME.test(step))) return 'edit';
  if (FILE_NAME.test(step) && MODIFY.test(step) && !/\b(create|new file|make (?:a |an )?(?:new |text |word )?(?:file|document)|write (?:a|an) )\b/i.test(step) && !/\b(read|open|show|summari[sz]e|tell me|what|which|how many|find|search|look)\b/i.test(step)) return 'edit';
  return null;
}

const STOP = new Set('a an the of to in on for and or with about my me it this that please write make create save me'.split(' '));
export function nameFor(goal, content = '') {
  const kind = goal.match(/\b(article|summary|essay|report|list|notes?|email|letter|story|poem|plan|recipe|outline|script|itinerary|review|bio|biography|cover letter|resume|cv)\b/i)?.[1]?.toLowerCase().replace(/\s+/g, '-');
  const about = goal.match(/\b(?:about|on|for|of|regarding)\s+([^.,;:!?()]+?)(?:\s+(?:and|then|to|in|into|inside|on my|as a|as an|and save)\b|[.,;:!?(]|$)/i)?.[1];
  const words = (about || content.split('\n')[0] || 'notes').toLowerCase().match(/[\p{L}\p{N}]+/gu) || ['notes'];
  const topic = words.filter(w => !STOP.has(w)).slice(0, 4).join('-') || 'notes';
  const ext = /\btext file\b|\.txt\b|\bplain text\b/i.test(goal) ? '.txt' : /\bword (?:document|doc|file)\b|\b(?:ms|microsoft) word\b|\bin word\b|\.docx\b/i.test(goal) ? '.docx' : /\bpdf\b/i.test(goal) ? '.pdf' : /\bspreadsheet|excel|\.xlsx\b/i.test(goal) ? '.xlsx' : /\bmarkdown\b|\.md\b/i.test(goal) ? '.md' : /\bhtml|web ?page\b/i.test(goal) ? '.html' : /\bpython\b|\.py\b/i.test(goal) ? '.py' : '.txt';
  return `${topic}${kind && !topic.includes(kind) ? `-${kind}` : ''}${ext}`;
}

export async function resolveTarget(step, goal, content) {
  const fromGoal = goal.match(FILE_NAME);
  const fromStep = step.match(FILE_NAME);
  const stepName = fromStep ? (fromStep[1] || fromStep[2]).trim() : null;
  const goalHasTarget = pathCandidates(goal).length > 0 || FOLDER_WORD.test(goal);
  const fileName = fromGoal ? (fromGoal[1] || fromGoal[2]).trim() : stepName && (!goalHasTarget || goal.toLowerCase().includes(stepName.toLowerCase())) ? stepName : null;
  const candidates = goalHasTarget ? [...pathCandidates(goal), ...pathCandidates(step)] : [...pathCandidates(step), ...pathCandidates(goal)];
  for (const c of candidates) {
    const r = await existing(c);
    if (r.exists && r.isDir) return { file: join(r.path, fileName ? basename(fileName) : nameFor(goal, content)), dirExisted: true, note: r.trimmed ? `using the existing folder ${r.path}` : null };
    if (r.exists && !r.isDir) return { file: r.path, dirExisted: true, overwrite: true };
    if (new RegExp(String.raw`\.(?:${EXT})$`, 'i').test(r.path)) return { file: r.path, dirExisted: fs.existsSync(dirname(r.path)) };
    return { file: join(r.path, fileName ? basename(fileName) : nameFor(goal, content)), dirExisted: false };
  }
  const folder = (goal.match(FOLDER_WORD) || step.match(FOLDER_WORD))?.[1]?.toLowerCase();
  const base = await P.resolvePath(folder || 'workspace');
  return { file: join(base, fileName ? basename(fileName) : nameFor(goal, content)), dirExisted: fs.existsSync(base) };
}

export function latestText(results) {
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (!r?.ok) continue;
    if (typeof r.text === 'string' && r.text.trim()) return r.text.trim();
    if (typeof r.raw?.answer === 'string' && r.raw.answer.trim()) return r.raw.answer.trim();
    if (typeof r.raw?.text === 'string' && r.raw.text.trim()) return r.raw.text.trim();
  }
  return null;
}

export function verifyFile(file, content) {
  if (!fs.existsSync(file)) return { ok: false, why: `${file} is not on disk` };
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) return { ok: false, why: `${file} is empty` };
  if (content && !DOC.test(file)) {
    const head = String(content).trim().slice(0, 40);
    if (head && !fs.readFileSync(file, 'utf8').includes(head)) return { ok: false, why: `${file} does not contain what was written` };
  }
  return { ok: true, bytes: stat.size };
}

function unique(file) {
  if (!fs.existsSync(file)) return file;
  const ext = extname(file), stem = file.slice(0, file.length - ext.length);
  for (let n = 2; n < 100; n++) if (!fs.existsSync(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
  return file;
}

export async function backup(file) {
  const dir = join(DATA, 'backups');
  await fsp.mkdir(dir, { recursive: true });
  const copy = join(dir, `${Date.now()}-${basename(file)}`);
  await fsp.copyFile(file, copy);
  return copy;
}

export async function planSave(step, goal, results) {
  const inline = step.match(/containing:\s*([\s\S]+)$/i)?.[1]?.trim();
  const content = inline || latestText(results);
  if (!content) return { error: 'there was no text from earlier steps to save' };
  const target = await resolveTarget(step, goal, content);
  const replace = target.overwrite && /\b(overwrite|replace)\b/i.test(`${step} ${goal}`);
  const file = target.overwrite && !replace ? unique(target.file) : target.file;
  return { file, content, note: target.note, title: content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) };
}

const MECHANICAL = [
  [/\b(?:replace|change)\s+["“']([^"”']+)["”']\s+(?:with|to|into)\s+["“']([^"”']*)["”']/i, (t, m) => ({ text: t.split(m[1]).join(m[2]), hits: t.split(m[1]).length - 1, how: `replaced “${m[1]}” with “${m[2]}”` })],
  [/\b(?:append|add)\s+["“']([^"”']+)["”']\s+(?:to the end|at the end|to the bottom|at the bottom)/i, (t, m) => ({ text: `${t.replace(/\s+$/, '')}\n${m[1]}\n`, hits: 1, how: `added “${m[1]}” at the end` })],
  [/\b(?:add|insert|put)\s+["“']([^"”']+)["”']\s+(?:at the top|at the start|at the beginning|to the top|to the beginning)/i, (t, m) => ({ text: `${m[1]}\n${t}`, hits: 1, how: `added “${m[1]}” at the top` })],
  [/\b(?:remove|delete)\s+(?:the\s+|every\s+|all\s+)?(?:line|lines|row|rows)\s+(?:containing|with|that (?:says?|mentions?))\s+["“']([^"”']+)["”']/i, (t, m) => { const lines = t.split('\n'); const kept = lines.filter(l => !l.includes(m[1])); return { text: kept.join('\n'), hits: lines.length - kept.length, how: `removed ${lines.length - kept.length} line(s) containing “${m[1]}”` }; }],
  [/\b(?:remove|delete)\s+["“']([^"”']+)["”']\s+from\b/i, (t, m) => ({ text: t.split(m[1]).join(''), hits: t.split(m[1]).length - 1, how: `removed “${m[1]}”` })]
];

export async function planEdit(step, goal, readText, signal) {
  const target = pathCandidates(step)[0] || pathCandidates(goal)[0] || (step.match(FILE_NAME) || goal.match(FILE_NAME))?.slice(1).find(Boolean);
  if (!target) return { error: 'no file was named to edit' };
  const found = await existing(target);
  let file = found.exists && !found.isDir ? found.path : null;
  if (!file) {
    const guess = await P.resolvePath(target);
    if (!fs.existsSync(guess)) return { error: `${guess} does not exist` };
    file = guess;
  }
  const before = await readText(file);
  for (const [re, apply] of MECHANICAL) {
    const m = step.match(re) || goal.match(re);
    if (!m) continue;
    const r = apply(before, m);
    if (!r.hits) return { error: `nothing in ${basename(file)} matched (${r.how})` };
    return { file, before, after: r.text, how: r.how };
  }
  if (before.length > 16000) return { error: `${basename(file)} is too long to rewrite safely in one go; name the exact text to replace` };
  const out = await mouth.say([
    { role: 'system', content: 'You edit a document. Apply the instruction and change only what it asks; keep every other line exactly as it is. Output the complete revised document and nothing else.' },
    { role: 'user', content: `INSTRUCTION: ${step}\n(The request was: ${goal})\n\nDOCUMENT:\n${before}` }
  ], { maxTokens: Math.min(3500, Math.ceil(before.length / 2.5) + 400), temperature: 0.15, signal });
  const after = out.text.replace(/^```\w*\n?|```\s*$/g, '').trim() + '\n';
  const whole = /\b(rewrite|rephrase|reword|translate|summari[sz]e|shorten|condense|expand|lengthen|whole|entire|all of)\b/i.test(step);
  const lines = before.split('\n').filter(l => l.trim()), kept = lines.filter(l => after.includes(l.trim())).length;
  if (!whole && lines.length >= 4 && kept / lines.length < 0.5) return { error: 'the edit would have changed far more than asked, so it was not applied' };
  if (after.trim() === before.trim()) return { error: 'the edit made no change' };
  return { file, before, after, how: 'rewrote the parts the instruction asked for' };
}

export async function writeEdit(file, after, writeDocument) {
  const saved = await backup(file);
  if (DOC.test(file)) await writeDocument({ path: file, title: basename(file).replace(/\.[^.]+$/, ''), content: after });
  else await fsp.writeFile(file, after, 'utf8');
  return saved;
}
