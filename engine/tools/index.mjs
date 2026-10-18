import compute from './compute.mjs';
import world from './world.mjs';
import money from './money.mjs';
import knowledge from './knowledge.mjs';
import language from './language.mjs';
import { computerTools } from './computer/index.mjs';
import { extraTools } from './extra.mjs';
import { webTools, isWebTask } from '../webtask.mjs';
import * as reflex from '../reflex.mjs';
import * as mouth from '../mouth.mjs';

export const tools = [...compute, ...world, ...money, ...knowledge, ...language];
const byId = Object.fromEntries(tools.map(t => [t.id, t]));

const MODES = {
  chat: ['hi', 'hello there', 'hey, how are you?', 'thanks!', 'thank you so much', 'good morning', 'who are you', 'what can you do', 'what is your name', 'tell me about yourself', "you're awesome", 'ok cool', 'bye', 'nice, thanks', 'can you help me with something', 'how is your day going', 'I am feeling sad today', 'lol that is funny', 'are you an AI'],
  creative: ['write a poem about the ocean', 'tell me a joke', 'write a short story about a dragon', 'compose a haiku about autumn', 'write a limerick about a cat', 'make up a bedtime story for my kid', 'write song lyrics about heartbreak', 'give me a funny pickup line', 'write a rap verse about pizza', 'brainstorm names for my bakery', 'write a birthday message for my mom', 'come up with a slogan for a coffee shop'],
  transform: ['translate "good morning" into Spanish', 'fix the grammar in this sentence: me and him goes to school', 'rewrite this to sound more professional: hey guys the meeting is moved', 'summarize this text: The quick brown fox...', 'make this email shorter: Dear John, I wanted to...', 'paraphrase this paragraph', 'translate this into French: where is the train station', 'correct my spelling: definately recieve', 'turn this into bullet points: ...', 'how do you say thank you in Japanese'],
  act: ['open notepad', 'open my downloads folder', 'create a folder called projects on my desktop', 'rename all the photos in my pictures folder by date', 'delete the old installers in my downloads', 'download the latest VLC installer', 'zip my documents folder', 'save these notes as a text file on my desktop', 'go to amazon and search for wireless headphones', 'fill out the form on this page', 'click the sign in button', 'type hello world into notepad', 'close all the chrome windows', 'install python on my computer', 'find my resume and open it', 'make a word document with a packing list', 'organize my downloads folder into subfolders by file type', 'convert this csv file to an excel spreadsheet', 'what programs are running right now', 'how much disk space is left on my computer', 'turn on dark mode', 'copy all my photos to an external drive', 'run this command for me', 'check which version of node is installed', 'set a reminder file for tomorrow', 'move every pdf from downloads into a new folder', 'open youtube and play some jazz', 'write an email to my boss and save it as a draft file', 'search my computer for files about taxes', 'take a screenshot of my screen'],
  research: ['how do I center a div in CSS', 'how to fix a python import error', 'best way to learn a new language', 'tips for a job interview', 'how do I get rid of ants', 'what is the best phone to buy', 'why does my car make a clicking noise', 'how to make pancakes', 'what should I know before adopting a dog', 'how do I improve my credit score', 'who invented the telephone', 'explain how vaccines work', 'what is quantum computing', 'best laptops for programming', 'history of the Roman Empire', 'how do I make sourdough bread', 'compare Python and JavaScript', 'why is the sky blue', 'what happened in the last US election', 'how does a car engine work', 'what are the symptoms of the flu', 'what is the latest iPhone', 'who won the champions league', 'is coffee bad for you', 'how to change a tire', 'what is the capital of Australia', 'tell me about the James Webb telescope', 'how does bitcoin mining work', 'what causes inflation', 'pros and cons of electric cars', 'how many people live in Tokyo', 'when did World War 2 end', 'what is a black hole']
};

let index = null;
export async function warm() {
  if (index) return index;
  const rows = [];
  for (const tool of tools) for (const example of tool.examples || []) rows.push({ id: tool.id, kind: 'tool', text: example });
  for (const [mode, examples] of Object.entries(MODES)) for (const example of examples) rows.push({ id: mode, kind: 'mode', text: example });
  const vectors = await reflex.embed(rows.map(r => r.text));
  rows.forEach((r, i) => { r.vector = vectors[i]; });
  index = rows;
  return index;
}

export async function route(message) {
  await warm();
  const started = performance.now();
  const [q] = await reflex.embed([message]);
  const best = {};
  for (const row of index) {
    const sim = reflex.cosine(q, row.vector);
    if (!best[row.id] || sim > best[row.id].sim) best[row.id] = { id: row.id, kind: row.kind, sim, example: row.text };
  }
  for (const tool of tools) if (tool.pattern?.test(message) && best[tool.id]) { best[tool.id].sim += 0.06; best[tool.id].pattern = true; }
  const ranked = Object.values(best).sort((a, b) => b.sim - a.sim);
  const modes = Object.fromEntries(Object.keys(MODES).map(m => [m, best[m].sim]));
  const candidates = ranked.filter(r => r.id !== 'research' && r.sim >= (r.kind === 'mode' ? 0.7 : 0.6) && r.sim - modes.research >= (r.pattern ? 0.04 : 0.07)).slice(0, 4);
  return { candidates, ranked: ranked.slice(0, 6).map(r => ({ id: r.id, sim: +r.sim.toFixed(3), pattern: Boolean(r.pattern) })), modes, ms: performance.now() - started };
}

const MAKES_A_FILE = /\b(save|export|download|store|put|write|create|make|generate)\b[^.?!]*\b(as|to|into|in|on)\b[^.?!]*(\.(txt|md|docx?|pdf|xlsx?|csv|json|html|png|jpe?g|zip)\b|\b(file|folder|desktop|documents|downloads|workspace|spreadsheet|word document|excel)\b)/i;

const COMPOUND = /\b(and|then|also|and then)\s+(open|save|send|download|create|make|put|move|copy|delete|install|email|write|add|set|play|launch|bookmark|print|share|zip|rename)\b|^(?:please\s+)?(go to|navigate to|visit|browse to|open up)\s+\S+[^?]*\b(and|then)\b/i;

export async function decide(message, { signal } = {}) {
  const routed = await route(message);
  if (MAKES_A_FILE.test(message) || COMPOUND.test(message) || isWebTask(message)) return { ...routed, mode: 'act', tool: null };
  for (const [i, c] of routed.candidates.entries()) {
    if (c.kind === 'mode') {
      const rival = routed.candidates.slice(i + 1).find(r => r.kind === 'tool' && r.pattern && c.sim - r.sim < 0.08);
      const ruled = rival && byId[rival.id].extract?.(message);
      if (ruled && isComplete(byId[rival.id], ruled)) return { ...routed, mode: 'research', tool: { id: rival.id, args: ruled, by: 'rules', sim: rival.sim } };
      return { ...routed, mode: c.id, tool: null };
    }
    const tool = byId[c.id];
    if (tool.pattern && !c.pattern && c.sim < 0.8) continue;
    const ruled = tool.extract ? tool.extract(message) : null;
    if (ruled && isComplete(tool, ruled)) return { ...routed, mode: 'research', tool: { id: tool.id, args: ruled, by: 'rules', sim: c.sim } };
    if (tool.args && c.sim >= 0.74) {
      const filled = await prepare(tool.id, message, { signal });
      if (filled) return { ...routed, mode: 'research', tool: { id: tool.id, args: filled.args, by: filled.by, sim: c.sim } };
    }
  }
  return { ...routed, mode: 'research', tool: null };
}

const isComplete = (tool, args) => (tool.required || Object.keys(tool.args || {})).every(k => args[k] != null && args[k] !== '');

export async function prepare(toolId, message, { signal } = {}) {
  const tool = byId[toolId];
  let args = tool.extract ? tool.extract(message) : null;
  if (args && isComplete(tool, args)) return { args, by: 'rules' };
  if (!tool.args) return args ? { args, by: 'rules' } : null;
  const schema = { type: 'object', properties: tool.args, required: Object.keys(tool.args) };
  const filled = await mouth.json([
    { role: 'system', content: `Extract the arguments for the tool "${tool.title}" (${tool.description}) from the user's request. Output JSON only.` },
    { role: 'user', content: message }
  ], schema, { signal }).catch(() => null);
  if (!filled) return null;
  return { args: { ...(args || {}), ...Object.fromEntries(Object.entries(filled).filter(([, v]) => v !== '' && v != null)) }, by: 'model' };
}

export async function runTool(toolId, args, ctx = {}) {
  const tool = byId[toolId];
  const started = performance.now();
  const result = await tool.run(args, ctx);
  return { id: tool.id, title: tool.title, family: tool.family, standalone: tool.standalone, args, ms: Math.round(performance.now() - started), ...result };
}

const asAgentTool = t => ({
  id: t.id, title: t.title, family: t.family, description: t.description, examples: t.examples, risk: 'read',
  parameters: t.args ? { type: 'object', properties: t.args, required: t.required || Object.keys(t.args) } : { type: 'object', properties: { request: { type: 'string', description: 'what to look up, in plain words' } }, required: ['request'] },
  run: async (args, ctx) => {
    const request = args.request || ctx?.step || ctx?.goal || '';
    const filled = t.args ? Object.fromEntries(Object.entries(args).filter(([, v]) => v !== '' && v != null)) : null;
    const input = t.args ? ((t.required || Object.keys(t.args)).every(k => filled[k] != null) ? filled : (t.extract?.(request) || filled)) : (t.extract?.(request) || { request, question: request, text: request });
    const r = await t.run(input, ctx); return { facts: r.facts, sources: (r.sources || []).map(s => s.url).filter(Boolean) }; }
});
export const agentTools = [...webTools, ...computerTools, ...extraTools, ...tools.filter(t => !['read_url', 'run_code'].includes(t.id)).map(asAgentTool)];
export const agentById = Object.fromEntries(agentTools.map(t => [t.id, t]));

export const catalogue = () => [...tools, ...webTools, ...computerTools, ...extraTools].map(t => ({ id: t.id, title: t.title, family: t.family, description: t.description, examples: (t.examples || []).slice(0, 3), standalone: Boolean(t.standalone), booster: Boolean(t.booster), agent: Boolean(t.agentOnly || t.parameters), risk: typeof t.risk === 'string' ? t.risk : t.risk ? 'depends' : null }));
export { byId };
