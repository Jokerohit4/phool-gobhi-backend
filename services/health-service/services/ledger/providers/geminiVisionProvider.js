import { ProviderError } from '../../../utils/providerError.js';
import { buildPrompt, parseJson, normaliseItem } from './visionShared.js';

// Gemini vision, spoken to over plain HTTP rather than through a vendor SDK, for
// the reason hostedProvider.js gives: every serious provider offers a plain HTTP
// shape, so changing vendor is a base URL and a model name. An SDK would put the
// vendor back in the dependency tree the adapter exists to keep out.
//
// This is the ONE place in the service that sends a user's image to a third
// party, which is why the feature sits behind its own admin flag that defaults
// off. Two consequences are enforced here rather than left to a policy document:
//
//   1. NO IDENTIFIERS IN THE PROMPT. Enforced in visionShared.js, which builds
//      every prompt this adapter sends under that rule — the request carries the
//      image bytes and nothing else.
//
//   2. NO RETENTION REQUESTED, AND THAT IS NOT ENFORCEABLE. Gemini's API takes
//      no zero-data-retention parameter, so the comment in the auth-service flag
//      that gates this feature is a real open question about a vendor account
//      setting, not a line of code. It belongs in the flag's documentation, which
//      is where it is. What this adapter CAN do is never write the image to a
//      log, never include it in an error message, and never send it anywhere
//      else.
//
// The response is constrained by a JSON schema rather than asked for politely.
// A model asked to "reply with JSON" will eventually reply with JSON and a
// sentence about it, and one of those replies reaches a Prisma write.
//
// Configuration is read per call rather than captured at module load: this
// adapter is one candidate in the rotation providers/index.js selects from, and
// a candidate's key/model pair has to be resolvable when the request is made
// (and, in tests, re-resolvable after the environment changes).

function currentConfig(config = {}) {
  // `||`, not `??`: an empty MODEL or BASE_URL is a blank field in the secret,
  // which reads as "use the default" — while the API key, the part with no
  // sensible default, stays empty and reports unconfigured.
  const baseUrl = String(
    config.baseUrl || process.env.FOOD_PHOTO_PROVIDER_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  )
    .trim()
    .replace(/\/+$/, '');
  // .trim() for the same reason every API key read in this repo does: a trailing
  // newline pasted out of Secret Manager has broken this fleet before.
  const apiKey = String(config.apiKey || process.env.FOOD_PHOTO_PROVIDER_API_KEY || '').trim();
  const model = String(config.model || process.env.FOOD_PHOTO_PROVIDER_MODEL || 'gemini-2.0-flash').trim();
  return { baseUrl, apiKey, model };
}

// Temperature 0 and a fixed schema, because this is a lookup and not a
// conversation. Creativity here shows up as a plate that is a different meal on
// every photograph of it, and the correction counter would then measure Gemini's
// mood rather than its accuracy.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    // The escape hatch that matters most. A photo of a dog, a document or an
    // empty plate has no items, and asking for a food from it is how a food log
    // ends up containing "banana" for a photo of a banana-shaped toy.
    isFood: { type: 'BOOLEAN' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          // The EXACT catalogue name this item is, when the provider is given
          // the catalogue and decides it is plausibly one of the rows. An empty
          // string is "not one of these, or not sure". The server resolves this
          // against the real names it sent — never against a name the model
          // invents — which is what lets a photo of "kaali dal" land on our
          // "Dal, cooked" row instead of bobbing through free-text matching.
          catalogue: { type: 'STRING' },
          grams: { type: 'INTEGER' },
          confidence: { type: 'NUMBER' },
          nonVeg: { type: 'BOOLEAN' },
        },
        required: ['name'],
        propertyOrdering: ['name', 'catalogue', 'grams', 'confidence', 'nonVeg'],
      },
    },
    // One short line for the user when the photo is ambiguous. Not a
    // description of the meal - the app renders it under a thumbnail, and a
    // paragraph there reads as an excuse.
    note: { type: 'STRING' },
  },
  required: ['isFood', 'items'],
  propertyOrdering: ['isFood', 'items', 'note'],
};

export function isConfigured(config = {}) {
  const { baseUrl, apiKey, model } = currentConfig(config);
  return Boolean(baseUrl && apiKey && model);
}

/**
 * Sends one image and returns the model's structured proposal.
 *
 * `config` selects a key/model pair when the caller is the rotation in
 * providers/index.js; omitted, the FOOD_PHOTO_PROVIDER_* environment answers,
 * which is the single-vendor behaviour this adapter had before the rotation
 * existed.
 *
 * Throws ProviderError. Never returns a partial shape: a caller that gets a
 * response can rely on `isFood` and `items` both being present, because a
 * response that fails to parse is an error rather than an empty result.
 */
export async function recognizeFood(
  { imageBase64, mimeType, catalogueText = '', timeoutMs = 20000 },
  config = {},
) {
  const { baseUrl, apiKey, model } = currentConfig(config);
  if (!isConfigured(config)) {
    throw new ProviderError('Food photo provider is not configured', {
      retryable: false,
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }
  if (!imageBase64) {
    throw new ProviderError('No image supplied', { retryable: false, code: 'NO_IMAGE' });
  }

  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: buildPrompt(catalogueText) }],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
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
    const body = await res.text().catch(() => '');
    throw new ProviderError(`Food photo provider returned ${res.status}`, {
      status: res.status,
      // 4xx means the request is wrong and retrying spends money to fail the
      // same way. 429 and 5xx are the provider's problem, not ours.
      retryable: res.status >= 500 || res.status === 429,
      code: 'PROVIDER_REJECTED',
      // The body is deliberately NOT included in the message. Provider error
      // payloads echo the request, and the request is a photograph.
    });
  }

  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';

  // A candidate blocked by the provider's own safety filter arrives with no
  // text. That is a real and expected outcome for this feature - people
  // photograph what they eat, and a photo of a person's body is not a plate - so
  // it is reported as "no food identified" rather than raised as a failure the
  // app would offer to retry.
  const blocked = body?.candidates?.[0]?.finishReason;
  if (!text) {
    return { isFood: false, items: [], note: null, model: body?.modelVersion || model, tokensIn: null, tokensOut: null, blockedReason: blocked || null };
  }

  const parsed = parseJson(text);

  return {
    isFood: parsed.isFood !== false,
    items: Array.isArray(parsed.items) ? parsed.items.map(normaliseItem).filter(Boolean) : [],
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null,
    model: body?.modelVersion || model,
    tokensIn: body?.usageMetadata?.promptTokenCount ?? null,
    tokensOut: body?.usageMetadata?.candidatesTokenCount ?? null,
  };
}
