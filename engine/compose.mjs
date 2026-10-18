import { longDate } from './util.mjs';

const VOICE = 'You are OpenSpawn Bot. You talk like a knowledgeable, friendly person: natural, warm and direct, in plain everyday words. You talk to the user as "you"; you never write as if you were the user.';
const persona = (fresh = true) => `${VOICE} You get straight to the point and never describe how you found the answer.${fresh ? ` For reference, today is ${longDate()}.` : ''}`;
const CAPABILITIES = 'What you can do: hold a conversation; write, rewrite, translate and summarise; look anything up live on the web and cross-check it across several independent sites; check weather, prices, news, maths and units with exact tools; and work on this computer: find, read, write and organise files, run commands, open apps and websites, and use the browser (asking first before changing anything).';

const SHAPES = {
  compare: `One sentence naming the key difference.

| | A | B |
|---|---|---|
| Attribute | value | value |
| Attribute | value | value |

**Bottom line:** one sentence.`,
  howto: `...overview sentence...

1. ...
2. ...
3. ...`,
  list: `...introduction sentence...

- **...** — ...
- **...** — ...`,
  news: `- **...date...** — ...
- **...date...** — ...`,
  advice: `...one or two warm sentences acknowledging the situation...

**Questions worth asking yourself**
- ...
- ...

**What the experts say**
- ...
- ...

**A next step:** ...`
};
export const FORMATS = {
  factoid: 'Start with one sentence that directly answers the question, with the key fact in **bold**. Then add two or three sentences of the most useful context from the evidence. No headings. Under 110 words.',
  explain: 'Start with a one or two sentence summary that answers the question. Then explain the key points in two or three short paragraphs, or a short bulleted list where that reads better. Under 230 words.',
  howto: 'Start with one sentence of overview. Then give clear numbered steps, each one short and concrete. End with one practical tip if the evidence has one. Under 230 words.',
  compare: 'Start with one sentence on the most important difference. Then a markdown table comparing the key attributes side by side. Then one short "Bottom line" sentence. Under 230 words.',
  list: 'Start with one short sentence of introduction. Then a bulleted list; each item gets a **bold** name and a short explanation. Under 230 words.',
  news: 'Summarise the latest developments, most recent first, with dates where the evidence gives them. Use a short bulleted list. Under 200 words.',
  code: 'Answer with a short explanation and a code block. Base the code on the evidence; keep it minimal and correct. Under 250 words.',
  tool: 'Answer in one to three sentences using the tool result. Put the key value in **bold**.',
  advice: 'This is a personal decision, and it is theirs to make: do not decide for them and do not lecture. Speak to them as "you" ("you could", "ask yourself"), never in their voice. Acknowledge the situation kindly in one or two sentences. Then give the questions that usually decide this kind of choice, what experts and the evidence say (with any real numbers, risks or costs from the facts), and one concrete, low-risk next step. If money, health or safety is involved, mention the main risk plainly. Under 230 words.',
  act: 'Talk to the user like a helpful friend. Lead with what they wanted: the answer, the result, the file that now exists, the thing that changed. Give file paths, numbers and names exactly. Do not list the tools or steps you used. If something did not work, say so plainly with the exact reason from the facts (for example that a file does not exist, and which files are there instead) and suggest what to try next. Never claim something happened that the facts do not show. You do have access to this computer: never say you are only an AI or that you cannot touch files. If the user declined a step, say it was not done because they declined it. Under 150 words.',
};

const RULES = `Rules:
- Use only facts found in the EVIDENCE and TOOL RESULTS. If something is not there, do not say it.
- Copy names, numbers and dates exactly as the evidence gives them.
- Write as an expert: state facts directly. Never mention "the evidence", "the sources" or "the passages".
- If the evidence does not answer the question, say plainly what is known and what is not.`;

function keyFacts(vote, tools) {
  const lines = [];
  for (const t of tools) for (const fact of t.facts) lines.push(`- ${fact}`);
  if (vote?.answer) {
    if (vote.settled) lines.push(`- Cross-checked answer: ${vote.answer} (${vote.agree} of ${vote.of} independent sites agree)`);
    else if (vote.alternatives.length > 1) lines.push(`- Sources give different figures: ${vote.alternatives.slice(0, 3).map(a => `${a.answer} (${a.sites.length} site${a.sites.length > 1 ? 's' : ''}${a.sites.includes('wikipedia.org') ? ', incl. Wikipedia' : ''})`).join('; ')}. Mention the difference if it matters.`);
  }
  return lines;
}

export function researchPrompt({ question, intent, evidence, vote, polar, tools = [], history = [], fresh = true, style = '' }) {
  const facts = keyFacts(vote, tools);
  const evidenceText = evidence.map(e => `[${e.id}] (${e.site}${e.date ? ', ' + String(e.date).slice(0, 10) : ''}) ${e.section && !/^(Overview|Search snippet)$/.test(e.section) ? e.section + ': ' : ''}${e.text}`).join('\n');
  const user = [
    `QUESTION: ${question}`,
    facts.length ? `\nKEY FACTS:\n${facts.join('\n')}` : '',
    polarLine(polar) ? `\n${polarLine(polar)}` : '',
    evidenceText ? `\nEVIDENCE:\n${evidenceText}` : '',
    `\n${RULES}`,
    `\nFORMAT: ${FORMATS[intent] || FORMATS.explain}${style ? ` ${style}` : ''}`,
    `\nNow answer: ${question}`
  ].join('\n');
  return [
    { role: 'system', content: `${persona(fresh)} You have no knowledge of your own; everything you state comes from the research given to you.` },
    ...historyMessages(history),
    { role: 'user', content: user }
  ];
}

export function factsPrompt({ question, intent, facts, vote, polar, history = [], fresh = true, style = '' }) {
  const lines = [`QUESTION: ${question}`];
  if (polarLine(polar)) lines.push(polarLine(polar));
  if (vote?.answer && vote.settled) lines.push(`CROSS-CHECKED ANSWER: ${vote.answer} (${vote.agree} of ${vote.of} independent sites agree)`);
  else if (vote?.alternatives?.length > 1) lines.push(`NOTE: the sources disagree: ${vote.alternatives.slice(0, 3).map(a => `${a.answer} (${a.sites.length} site${a.sites.length > 1 ? 's' : ''}: ${a.sites.slice(0, 2).join(', ')})`).join('; ')}. Say plainly that sources disagree and which says what. Do not pick one as fact.`);
  else if (vote?.answer) lines.push(`NOTE: only one site (${vote.alternatives?.[0]?.sites?.[0] || 'one source'}) gives the answer "${vote.answer}". Say that you could only find it on one site and it is not confirmed.`);
  lines.push('FACTS FROM LIVE SOURCES:\n' + facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n'));
  lines.push('TASK: Answer the question using only these facts. Combine and rephrase them so they read naturally; keep every name, number and date exactly as written; add nothing that is not in the facts; never mention "the facts" or "the sources".');
  lines.push(`FORMAT: ${FORMATS[intent] || FORMATS.explain}${style ? ` The user asked: ${style}` : ''}`);
  if (SHAPES[intent]) lines.push(`SHAPE TO FOLLOW:\n${SHAPES[intent]}`);
  lines.push(`Answer: ${question}`);
  return [
    { role: 'system', content: `${persona(fresh)} You have no knowledge of your own; you write answers from facts that were researched for you.` },
    ...historyMessages(history),
    { role: 'user', content: lines.join('\n\n') }
  ];
}

export function chatPrompt({ message, history = [], kind }) {
  const guide = kind === 'creative'
    ? 'Write what is asked with style and care. Keep it reasonably short unless asked otherwise. Output only the piece itself.'
    : kind === 'transform'
      ? 'Do exactly the transformation asked (translate, rewrite, summarise, fix) on the text the user gives. Output only the result.'
      : `Chat like a friend would: warm, natural and brief, with real interest in the person. Pick up on what they said earlier in the conversation. Only ask a question back when you genuinely need to know something. You never state facts about the world from memory; for those you look them up. ${CAPABILITIES} If they ask what you can do, answer briefly from that list.`;
  return [
    { role: 'system', content: `${VOICE} ${guide}` },
    ...historyMessages(history),
    { role: 'user', content: message }
  ];
}

export function polarLine(polar) {
  if (!polar?.verdict) return '';
  const quote = x => `"${x.text.slice(0, 160)}" (${x.site})`;
  if (polar.verdict === 'yes') return `CROSS-CHECKED ANSWER: Yes. ${polar.yes.length} independent sites state it, for example ${quote(polar.yes[0])}. Start your answer with "Yes".`;
  if (polar.verdict === 'no') return `CROSS-CHECKED ANSWER: No. It is not true that ${polar.statement.replace(/\.$/, '').replace(/^./, c => c.toLowerCase())}: ${quote(polar.no[0])}${polar.qualified[0] ? `; also ${quote(polar.qualified[0])}` : ''}. Start your answer with "No" and give the reason.`;
  if (polar.verdict === 'qualified') return `CROSS-CHECKED ANSWER: Not exactly. The sources qualify it: ${quote(polar.qualified[0])}. Do not answer with a plain "Yes": start with the qualification${polar.qualified[0].word ? ` ("${polar.qualified[0].word}")` : ''} and explain it.`;
  if (polar.verdict === 'mixed') return `NOTE: sources disagree on this: ${quote(polar.yes[0])} but ${quote(polar.no[0])}. Say that it is disputed and give both sides; do not answer with a plain yes or no.`;
  return '';
}

function historyMessages(history) {
  return history.slice(-4).flatMap(turn => [
    { role: 'user', content: turn.question },
    { role: 'assistant', content: String(turn.answer || '').slice(0, 1400) }
  ]);
}

export function rewritePrompt(history, message) {
  const last = history.at(-1);
  return [
    { role: 'system', content: 'Rewrite the follow-up so it can be understood with no context: replace pronouns and vague references with the names they refer to. Keep it a question. Output JSON.' },
    { role: 'user', content: 'Previous question: Who is the CEO of Tesla?\nPrevious answer: Elon Musk is the CEO of Tesla.\nFollow-up: how old is he?' },
    { role: 'assistant', content: '{"standalone":"How old is Elon Musk?"}' },
    { role: 'user', content: 'Previous question: What is the capital of Japan?\nPrevious answer: Tokyo is the capital of Japan.\nFollow-up: and the population?' },
    { role: 'assistant', content: '{"standalone":"What is the population of Tokyo?"}' },
    { role: 'user', content: `${history.length > 1 ? `Earlier question: ${history.at(-2).question}\n` : ''}Previous question: ${last.question}\nPrevious answer: ${String(last.answer || '').slice(0, 500)}\nFollow-up: ${message}` }
  ];
}
