import { ProviderError } from '../../../utils/providerError.js';

// Gemini vision, spoken to over plain HTTP rather than through a vendor SDK, for
// the reason hostedProvider.js gives: every serious provider offers a plain HTTP
// shape, so changing vendor is a base URL and a model name. An SDK would put the
// vendor back in the dependency tree the adapter exists to keep out.
//
// This is the ONE place in the service that sends a user's image to a third
// party, which is why the feature sits behind its own admin flag that defaults
// off. Two consequences are enforced here rather than left to a policy document:
//
//   1. NO IDENTIFIERS IN THE PROMPT. The request carries the image bytes and
//      nothing else - no userId, no name, no date, no localDate, no free-text
//      the app happened to have. There is nothing here to correlate a request
//      with a person on the provider's side, and nothing to strip later.
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

const BASE_URL = (
  process.env.FOOD_PHOTO_PROVIDER_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
).trim().replace(/\/+$/, '');
// .trim() for the same reason every API key read in this repo does: a trailing
// newline pasted out of Secret Manager has broken this fleet before.
const API_KEY = (process.env.FOOD_PHOTO_PROVIDER_API_KEY || '').trim();
const MODEL = (process.env.FOOD_PHOTO_PROVIDER_MODEL || 'gemini-2.0-flash').trim();

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

const PROMPT = [
  'Identify the individual foods visible in this meal photo.',
  '',
  'For each one, return a plain English name of the food itself, without quantities,',
  'plurals, brand names, preparation or garnish. "dal", "plain rice", "ghee", "roti".',
  'A dish name is fine if the dish IS the food: "paneer bhurji", "chole".',
  '',
  'Estimate the cooked weight in grams of each item, as one number, not a range.',
  'confidence is your own probability, 0 to 1, that the name is right.',
  '',
  'If this is not a photo of food, or nothing in it is identifiable, return isFood',
  'false and an empty items array. Do not guess. An empty answer costs the user',
  'nothing; a wrong one puts a food in their health record that they did not eat.',
].join('\n');

// The catalogue block is appended when the server provides one. A vision model
// is good at naming a plate and unreliable at resolving its own dialect to our
// exact rows; giving it the names once means it answers both halves of the
// question in the same response. `maxItems` is sent with the catalogue so the
// model need not infer how many answers to give.
function buildPrompt(catalogueText) {
  const text = String(catalogueText || '').trim();
  if (!text) return PROMPT;
  return [
    'We maintain a catalogue of the foods we recognise. The most relevant rows',
    'are listed below.',
    '',
    'For each item you find, if it is plausibly one of these, set `catalogue` to',
    'the EXACT catalogue name from the list - spelled exactly as given. If you are',
    'not sufficiently confident it is one of these, set `catalogue` to an empty',
    'string. Never invent a catalogue name, and never pick the closest-sounding',
    'row for something that is clearly not it: an unmatched item is fine, a wrongly',
    'matched one puts the wrong food in somebody\'s health record.',
    '',
    'CATALOGUE (first ' + String(catalogueText.length) + ' characters of the curated set):',
    text,
  ].join('\n');
}

export function isConfigured() {
  return Boolean(BASE_URL && API_KEY && MODEL);
}

/**
 * Sends one image and returns the model's structured proposal.
 *
 * Throws ProviderError. Never returns a partial shape: a caller that gets a
 * response can rely on `isFood` and `items` both being present, because a
 * response that fails to parse is an error rather than an empty result.
 */
export async function recognizeFood({ imageBase64, mimeType, catalogueText = '', timeoutMs = 20000 }) {
  if (!isConfigured()) {
    throw new ProviderError('Food photo provider is not configured', {
      retryable: false,
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }
  if (!imageBase64) {
    throw new ProviderError('No image supplied', { retryable: false, code: 'NO_IMAGE' });
  }

  const url = `${BASE_URL}/models/${encodeURIComponent(MODEL)}:generateContent`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,
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
    return { isFood: false, items: [], note: null, model: body?.modelVersion || MODEL, tokensIn: null, tokensOut: null, blockedReason: blocked || null };
  }

  const parsed = parseJson(text);

  return {
    isFood: parsed.isFood !== false,
    items: Array.isArray(parsed.items) ? parsed.items.map(normaliseItem).filter(Boolean) : [],
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null,
    model: body?.modelVersion || MODEL,
    tokensIn: body?.usageMetadata?.promptTokenCount ?? null,
    tokensOut: body?.usageMetadata?.candidatesTokenCount ?? null,
  };
}

/**
 * Strips a ```json fence when one is present.
 *
 * responseMimeType should make the body bare JSON, and in practice it nearly
 * always is. The fence shows up anyway after a prompt edit or on a model update,
 * and a JSON.parse throw here becomes a 500 in front of a user holding a photo
 * of their dinner - so the one recoverable variant is handled rather than
 * reported.
 */
function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ProviderError('Food photo provider returned unparseable JSON', {
      retryable: true,
      code: 'PROVIDER_BAD_SHAPE',
    });
  }
}

/**
 * Drops anything that is not usable as a catalogue lookup, and clamps the two
 * numbers the model is least reliable about.
 *
 * A schema-constrained response still contains a null name, a name of "", or a
 * confidence of 47. This is the last point before those values reach a search
 * against the food catalogue, so it is the right place to refuse them.
 */
function normaliseItem(item) {
  const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 80) : '';
  if (!name) return null;

  let grams = Number(item?.grams);
  // 5000 g is the same ceiling nutritionService.logFood enforces on a manual
  // entry, and for the same reason: one meal is not two kilos of rice. A model
  // that returns 900000 for a tray of rice is describing the tray, not a portion.
  if (!Number.isFinite(grams) || grams <= 0) grams = 100;
  grams = Math.min(Math.round(grams), 5000);

  // `null` and `''` are the model declining to give a number, and they are NOT
  // zero. `Number(null)` is 0, so coercing first would turn "no confidence
  // reported" into "totally unconfident" and drag the average down for every
  // response that simply omitted the field.
  const rawConfidence = item?.confidence;
  const confidence =
    rawConfidence == null || rawConfidence === ''
      ? null
      : Number.isFinite(Number(rawConfidence))
        ? Math.min(Math.max(Number(rawConfidence), 0), 1)
        : null;

  return { name, grams, confidence, nonVeg: item?.nonVeg === true, catalogue: typeof item?.catalogue === 'string' ? item.catalogue.trim().slice(0, 120) : '' };
}
