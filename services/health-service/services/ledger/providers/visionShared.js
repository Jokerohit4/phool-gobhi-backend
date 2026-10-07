import { ProviderError } from '../../../utils/providerError.js';

// The half of the vision exchange that does not depend on which vendor is on
// the other end: what the model is asked, how the reply is unwrapped, and the
// last line of defence on the values that reach a catalogue search. Both
// adapters (geminiVisionProvider, openaiVisionProvider) share these so a
// prompt edit is one edit, and so a normalisation rule cannot drift between
// vendors — a rule that exists to stop "900000 g of rice" reaching logFood
// must not apply on one chain and not the other.

// NO IDENTIFIERS IN THE PROMPT. This is the ONE place in the service that
// sends a user's image to a third party (the feature sits behind its own admin
// flag that defaults off), and what the request carries is the image bytes and
// nothing else — no userId, no name, no date, no localDate, no free text the
// app happened to have. There is nothing on the provider's side to correlate a
// request with a person, and nothing to strip later. The prompt below must
// stay a description of a plate, never of a person.
export const PROMPT = [
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
export function buildPrompt(catalogueText) {
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

/**
 * Strips a ```json fence when one is present.
 *
 * A schema-constrained or JSON-mode reply should be bare JSON, and in practice
 * it nearly always is. The fence shows up anyway after a prompt edit or on a
 * model update, and a JSON.parse throw here becomes a 500 in front of a user
 * holding a photo of their dinner - so the one recoverable variant is handled
 * rather than reported.
 */
export function parseJson(text) {
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
export function normaliseItem(item) {
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
