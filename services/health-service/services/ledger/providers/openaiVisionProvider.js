import { ProviderError } from '../../../utils/providerError.js';
import { buildPrompt, parseJson, normaliseItem } from './visionShared.js';

// The second vendor in the rotation: an OpenAI-compatible chat-completions
// endpoint with image input. It exists because a demand spike on one vendor
// must be able to move to a DIFFERENT key and a DIFFERENT model — the 503s
// that made this feature a coin flip during peak hours were Gemini's capacity,
// and re-asking Gemini is not a retry, it is the same coin flip.
//
// The shape is deliberately the one every OpenAI-compatible gateway speaks
// (Groq today; the vendor behind a future FOOD_PHOTO_PROVIDER_CANDIDATES entry
// tomorrow), for the reason geminiVisionProvider.js gives about plain HTTP:
// changing vendor is a base URL and a model name, not a dependency.
//
// Two consequences carried over from the gemini adapter, both enforced here:
//
//   1. NO IDENTIFIERS IN THE PROMPT — visionShared.js builds every prompt
//      under that rule; this adapter adds only the JSON-shape instruction,
//      which describes a plate, never a person.
//
//   2. The provider's error body never reaches a message, a log, or a user.
//      Provider error payloads echo the request, and the request is a
//      photograph.
//
// Configuration arrives as an argument (providers/index.js resolves the
// rotation candidate per attempt) rather than being captured at module load.
// There is no environment fallback on purpose: this adapter's credentials
// belong to a candidate in that rotation, and a candidate the admin has not
// configured must be absent from the chain, not silently defaulted.

const JSON_INSTRUCTION = [
  '',
  'Reply with ONLY a single JSON object and no prose before or after it, of the shape:',
  '{"isFood": <bool>, "items": [{"name": <string>, "catalogue": <string>,',
  '"grams": <number>, "confidence": <number between 0 and 1>, "nonVeg": <bool>}],',
  '"note": <string or null>}.',
].join('\n');

function resolveConfig(config = {}) {
  return {
    baseUrl: String(config.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(config.apiKey || '').trim(),
    model: String(config.model || '').trim(),
  };
}

export function isConfigured(config = {}) {
  const { baseUrl, apiKey, model } = resolveConfig(config);
  return Boolean(baseUrl && apiKey && model);
}

/**
 * Sends one image and returns the model's structured proposal.
 *
 * Same contract as the gemini adapter: throws ProviderError, never returns a
 * partial shape, and the proposal's numbers have already been through
 * visionShared.normaliseItem before a caller sees them.
 */
export async function recognizeFood(
  { imageBase64, mimeType, catalogueText = '', timeoutMs = 20000 },
  config = {},
) {
  if (!isConfigured(config)) {
    throw new ProviderError('Food photo provider is not configured', {
      retryable: false,
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }
  if (!imageBase64) {
    throw new ProviderError('No image supplied', { retryable: false, code: 'NO_IMAGE' });
  }
  const { baseUrl, apiKey, model } = resolveConfig(config);

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        // JSON mode rather than a schema: Groq's structured-output support is
        // per-model, while json_object is the contract every OpenAI-compatible
        // gateway honours — and a wrong guess here must degrade to a rejected
        // call, not to prose reaching a Prisma write. parseJson in
        // visionShared is what keeps that guarantee on the response side.
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(catalogueText) + JSON_INSTRUCTION },
              // A data URL, not a separate upload: the bytes are already here,
              // and a second request to a file host would be a second place a
              // photograph of somebody's meal could travel.
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(err.message || 'Food photo provider unreachable', {
      retryable: true,
      code: 'PROVIDER_UNREACHABLE',
    });
  }

  if (!res.ok) {
    await res.text().catch(() => '');
    throw new ProviderError(`Food photo provider returned ${res.status}`, {
      status: res.status,
      // 4xx means the request is wrong and retrying spends money to fail the
      // same way. 429 and 5xx are the provider's problem, not ours.
      retryable: res.status >= 500 || res.status === 429,
      code: 'PROVIDER_REJECTED',
      // The body is deliberately NOT included in the message; see header.
    });
  }

  const body = await res.json();
  const message = body?.choices?.[0]?.message;
  const text = typeof message?.content === 'string' ? message.content : '';
  const finishReason = body?.choices?.[0]?.finish_reason ?? null;

  // No content is one of two very different things. A content filter tripping
  // is the same expected outcome the gemini adapter reports as "no food
  // identified" — people photograph what they eat, and a photo of a person is
  // not a plate. Anything else (truncation, an empty reply with no reason) is a
  // broken response: reporting it as "no food" would silently drop a meal the
  // user paid to have read, and reporting it as BAD_SHAPE lets the rotation
  // move on to the next candidate.
  if (!text) {
    if (finishReason === 'content_filter') {
      return { isFood: false, items: [], note: null, model: body?.model || model, tokensIn: null, tokensOut: null, blockedReason: finishReason };
    }
    throw new ProviderError('Food photo provider returned an empty response', {
      retryable: true,
      code: 'PROVIDER_BAD_SHAPE',
    });
  }

  const parsed = parseJson(text);

  return {
    isFood: parsed.isFood !== false,
    items: Array.isArray(parsed.items) ? parsed.items.map(normaliseItem).filter(Boolean) : [],
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null,
    model: body?.model || model,
    tokensIn: body?.usage?.prompt_tokens ?? null,
    tokensOut: body?.usage?.completion_tokens ?? null,
  };
}
