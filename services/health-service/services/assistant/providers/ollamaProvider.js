import { ProviderError } from './index.js';

// Local development only — see providers/index.js, which refuses to load this
// in production. Same interface as hostedProvider so the rest of the service
// cannot tell them apart.
const BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'llama3';

export function isConfigured() {
  return true; // a local Ollama needs no credentials
}

export async function generate({ systemPrompt, messages, maxTokens, timeoutMs = 60000 }) {
  // A longer default timeout than the hosted path: local inference on a
  // developer laptop is slow, and a dev waiting 40s is not an incident.
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        options: { num_predict: maxTokens },
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(
      `Ollama unreachable at ${BASE_URL} — is it running? (${err.message})`,
      { retryable: true }
    );
  }

  if (!res.ok) {
    throw new ProviderError(`Ollama returned ${res.status}`, {
      status: res.status,
      retryable: res.status >= 500,
    });
  }

  const body = await res.json();
  const content = body?.message?.content;
  if (!content) throw new ProviderError('Ollama returned no content', { retryable: true });

  return {
    content: content.trim(),
    tokensIn: body?.prompt_eval_count ?? null,
    tokensOut: body?.eval_count ?? null,
    model: body?.model || MODEL,
  };
}
