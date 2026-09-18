import { ProviderError } from './index.js';

// Deliberately spoken to over plain HTTP with an OpenAI-compatible chat shape,
// rather than a vendor SDK. Every serious hosted provider offers this shape,
// so switching vendors is a base-URL and a model name — which is the point of
// having an adapter at all. A vendor SDK here would put the vendor back in the
// dependency tree the adapter exists to keep out.
const BASE_URL = (process.env.ASSISTANT_PROVIDER_BASE_URL || '').trim().replace(/\/+$/, '');
// .trim() for the same reason every INTERNAL_API_KEY read in this repo does:
// a trailing newline pasted into Secret Manager has broken this fleet twice.
const API_KEY = (process.env.ASSISTANT_PROVIDER_API_KEY || '').trim();
const MODEL = (process.env.ASSISTANT_PROVIDER_MODEL || '').trim();

export function isConfigured() {
  return Boolean(BASE_URL && API_KEY && MODEL);
}

export async function generate({ systemPrompt, messages, maxTokens, timeoutMs = 20000 }) {
  if (!isConfigured()) {
    throw new ProviderError('Assistant provider is not configured', { retryable: false });
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network failure or timeout — worth one retry, unlike a refusal.
    throw new ProviderError(err.message || 'Assistant provider unreachable', { retryable: true });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderError(`Assistant provider returned ${res.status}: ${body.slice(0, 200)}`, {
      status: res.status,
      // 5xx and 429 are worth trying again; a 4xx means the request itself is
      // wrong and retrying just spends money to fail identically.
      retryable: res.status >= 500 || res.status === 429,
    });
  }

  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new ProviderError('Assistant provider returned no content', { retryable: true });
  }

  return {
    content: content.trim(),
    tokensIn: body?.usage?.prompt_tokens ?? null,
    tokensOut: body?.usage?.completion_tokens ?? null,
    model: body?.model || MODEL,
  };
}
