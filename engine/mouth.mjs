export const config = {
  endpoint: process.env.ZK_LLM || 'http://127.0.0.1:8081/v1',
  model: process.env.ZK_MODEL || 'mouth',
  thinking: false
};

async function complete(body, { signal, onToken } = {}) {
  const stream = Boolean(onToken);
  const response = await fetch(`${config.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: config.model,
      temperature: 0.3,
      top_p: 0.9,
      repeat_penalty: 1.08,
      stream,
      chat_template_kwargs: { enable_thinking: config.thinking },
      ...body
    })
  });
  if (!response.ok) throw new Error(`Language model error ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (!stream) {
    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '', usage: data.usage, timings: data.timings };
  }
  const decoder = new TextDecoder();
  let text = '', buffer = '', timings = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        const piece = data.choices?.[0]?.delta?.content || '';
        if (data.timings) timings = data.timings;
        if (piece) { text += piece; onToken(piece, text); }
      } catch {}
    }
  }
  return { text, timings };
}

export async function say(messages, { maxTokens = 700, temperature = 0.3, signal, onToken, stop } = {}) {
  return complete({ messages, max_tokens: maxTokens, temperature, stop }, { signal, onToken });
}

export async function json(messages, schema, { maxTokens = 300, signal, temperature = 0.1 } = {}) {
  const { text } = await complete({
    messages, max_tokens: maxTokens, temperature,
    response_format: { type: 'json_schema', json_schema: { name: 'out', schema, strict: true } }
  }, { signal });
  try { return JSON.parse(text); } catch { return null; }
}

export async function pick(messages, options, { signal } = {}) {
  const result = await json(messages, { type: 'object', properties: { choice: { enum: options } }, required: ['choice'] }, { maxTokens: 30, signal });
  return result?.choice ?? options[0];
}

export async function health() {
  try {
    const base = config.endpoint.replace(/\/v1\/?$/, '');
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { ok: false };
    const props = await fetch(`${base}/props`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => ({}));
    return { ok: true, model: props.model_alias || props.model_path?.split(/[\\/]/).pop() || config.model, context: props.default_generation_settings?.n_ctx };
  } catch { return { ok: false }; }
}
