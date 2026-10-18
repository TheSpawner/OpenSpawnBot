import { pipeline, env, AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { RUNTIME } from './util.mjs';

env.cacheDir = join(RUNTIME, 'encoders');
env.allowRemoteModels = true;

const MODELS = {
  embed: 'Xenova/bge-small-en-v1.5',
  rerank: 'Xenova/ms-marco-MiniLM-L-6-v2',
  nli: 'Xenova/nli-deberta-v3-xsmall',
  extract: 'Xenova/distilbert-base-cased-distilled-squad'
};

let loading = null;
const m = {};

const files = new Map();
const progress_callback = p => { if (p.status === 'progress' && p.total) files.set(`${p.name}/${p.file}`, { loaded: p.loaded, total: p.total }); };
export const fetched = () => { let loaded = 0; for (const f of files.values()) loaded += f.loaded; return loaded; };
export const cached = () => Object.values(MODELS).every(id => existsSync(join(env.cacheDir, ...id.split('/'), 'onnx', 'model_quantized.onnx')));

export function load() {
  loading ||= (async () => {
    const started = performance.now();
    const pair = async name => ({
      tokenizer: await AutoTokenizer.from_pretrained(MODELS[name], { progress_callback }),
      model: await AutoModelForSequenceClassification.from_pretrained(MODELS[name], { dtype: 'q8', progress_callback })
    });
    [m.embed, m.rerank, m.nli, m.extract] = await Promise.all([
      pipeline('feature-extraction', MODELS.embed, { dtype: 'q8', progress_callback }),
      pair('rerank'),
      pair('nli'),
      pipeline('question-answering', MODELS.extract, { dtype: 'q8', progress_callback })
    ]);
    const labels = m.nli.model.config.id2label;
    m.nliIndex = Object.fromEntries(Object.entries(labels).map(([i, label]) => [label.toLowerCase(), Number(i)]));
    return Math.round(performance.now() - started);
  })();
  return loading;
}

const softmax = values => {
  const max = Math.max(...values);
  const exps = values.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);
};
const sigmoid = x => 1 / (1 + Math.exp(-x));

const BATCH = 32;

export async function embed(texts) {
  await load();
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const tensor = await m.embed(texts.slice(i, i + BATCH).map(t => String(t).slice(0, 1200)), { pooling: 'cls', normalize: true });
    const [n, d] = tensor.dims;
    for (let j = 0; j < n; j++) out.push(tensor.data.slice(j * d, (j + 1) * d));
  }
  return out;
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function pairLogits(which, firsts, seconds) {
  await load();
  const { tokenizer, model } = m[which];
  const rows = [];
  for (let i = 0; i < firsts.length; i += BATCH) {
    const inputs = tokenizer(firsts.slice(i, i + BATCH), { text_pair: seconds.slice(i, i + BATCH), padding: true, truncation: true, max_length: 512 });
    const { logits } = await model(inputs);
    const [n, k] = logits.dims;
    for (let j = 0; j < n; j++) rows.push(Array.from(logits.data.slice(j * k, (j + 1) * k)));
  }
  return rows;
}

export async function rerank(query, passages) {
  if (!passages.length) return [];
  const rows = await pairLogits('rerank', passages.map(() => query), passages);
  return rows.map(([logit]) => ({ logit, p: sigmoid((logit - 2) / 2.5) }));
}

export async function nli(premises, hypotheses) {
  if (!premises.length) return [];
  const rows = await pairLogits('nli', premises, hypotheses);
  const { entailment: E, neutral: N, contradiction: C } = m.nliIndex;
  return rows.map(row => { const p = softmax(row); return { entail: p[E], neutral: p[N], contradict: p[C] }; });
}

export async function extract(question, contexts, { k = 1 } = {}) {
  await load();
  return Promise.all(contexts.map(async context => {
    try {
      const result = await m.extract(question, context, k > 1 ? { top_k: k } : undefined);
      const list = (Array.isArray(result) ? result : [result]).map(r => ({ answer: restoreSpan(r.answer || '', context), score: r.score || 0 }));
      return k > 1 ? list : list[0];
    } catch { return k > 1 ? [] : { answer: '', score: 0 }; }
  }));
}

function restoreSpan(answer, context) {
  const compact = answer.replace(/\s+/g, '');
  if (!compact) return '';
  const pattern = compact.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  const found = context.match(new RegExp(pattern, 'i'));
  return (found ? found[0] : answer).trim();
}

export async function choice(text, options, { template = d => d } = {}) {
  const keys = Object.keys(options);
  const rows = await pairLogits('nli', keys.map(() => text), keys.map(k => template(options[k])));
  const { entailment: E, contradiction: C } = m.nliIndex;
  const scores = rows.map(row => row[E] - row[C]);
  const probabilities = softmax(scores.map(s => s * 1.5));
  const best = probabilities.indexOf(Math.max(...probabilities));
  const sorted = [...probabilities].sort((a, b) => b - a);
  return {
    choice: keys[best],
    confidence: sorted[0] - (sorted[1] || 0),
    probabilities: Object.fromEntries(keys.map((k, i) => [k, probabilities[i]]))
  };
}

export async function noul(statement, evidence) {
  const list = Array.isArray(evidence) ? evidence : [evidence];
  if (!list.length) return { yes: 0, no: 0, best: -1 };
  const results = await nli(list, list.map(() => statement));
  let best = 0;
  results.forEach((r, i) => { if (r.entail > results[best].entail) best = i; });
  const worst = results.reduce((a, r) => Math.max(a, r.contradict), 0);
  return { yes: results[best].entail, no: worst, best, all: results };
}

export const models = MODELS;
