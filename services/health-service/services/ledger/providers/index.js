import * as geminiVisionProvider from './geminiVisionProvider.js';
import * as openaiVisionProvider from './openaiVisionProvider.js';
import { ProviderError } from '../../../utils/providerError.js';

// Provider selection for food-photo recognition: the rotation.
//
// The client counts failed recognitions and sends the attempt number with each
// request — one provider call per attempt, because the retry loop is the user
// tapping Retry (see foodPhotoService.recognizePhoto) — and this file maps the
// attempt onto a candidate key/model pair:
//
//     candidates()[(attempt - 1) % candidates.length]
//
// Rotation across vendors is the whole point. A demand spike on one vendor —
// measured on the dev key: gemini-3.5-flash answered 503 on roughly half the
// calls during peak hours — must move the NEXT attempt to a different key and
// a different model rather than re-ask the same overloaded endpoint. The chain
// therefore always starts at the primary vendor (an app version that sends no
// attempt number lands on candidate 1, which is the vendor it always had) and
// cycles through everything configured after it.
//
// DEFAULT CHAIN — built from keys that are already deployed, no new secrets:
//
//   1. Gemini    FOOD_PHOTO_PROVIDER_* (the legacy single-provider vars).
//   2. Groq      the assistant's ASSISTANT_PROVIDER_* gateway — same key, but
//                its vision-capable model rather than the assistant's text one.
//                Absent when no assistant key is configured.
//
// To add vendors (or replace the pair above): FOOD_PHOTO_PROVIDER_CANDIDATES,
// a JSON string in SECRETS_JSON, e.g.
//
//   [{"provider":"gemini","baseUrl":"…","apiKey":"…","model":"…"},
//    {"provider":"openai","baseUrl":"https://api.groq.com/openai/v1",
//     "apiKey":"…","model":"qwen/qwen3.8-27b"}]
//
// written with `node deploy/scripts/merge-secret-keys.cjs --from-json`, which
// trims values and never echoes them. `provider` is "gemini" (the generateContent
// shape) or "openai" (chat completions); an explicit list REPLACES the default
// chain rather than extending it, so rotating a key off is a paste, not a code
// change. An unparseable list yields NO candidates — silently falling back to
// the default chain would keep calling the vendor the admin just rotated away
// from, which is the one thing the override exists to prevent. No candidates
// means the route answers 503, which the app can explain.

// Groq's multimodal model. Hardcoded as the default second candidate because
// the pairing that matters is key+model on ONE gateway: the assistant's key is
// the key we already have, and this is the vision model on it (the assistant's
// own gpt-oss model cannot see an image). Overridable per deployment only via
// the candidates list above — an env var per candidate is how a rotation
// becomes unreviewable.
const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export { ProviderError, isProviderError } from '../../../utils/providerError.js';

function envTrim(name) {
  return (process.env[name] || '').trim();
}

function defaultCandidates() {
  const out = [
    // The gemini adapter reads FOOD_PHOTO_PROVIDER_* itself when handed an
    // empty config, so the legacy vars keep working exactly as before —
    // including their base URL and model defaults.
    { provider: 'gemini', config: {} },
  ];
  const groq = {
    provider: 'openai',
    config: {
      // Derived together on purpose: a key and the base URL it belongs to are
      // one fact, and splitting them across vendors is how a rotation ends up
      // sending key A to vendor B.
      baseUrl: envTrim('ASSISTANT_PROVIDER_BASE_URL') || GROQ_BASE_URL,
      apiKey: envTrim('ASSISTANT_PROVIDER_API_KEY'),
      model: GROQ_VISION_MODEL,
    },
  };
  if (openaiVisionProvider.isConfigured(groq.config)) out.push(groq);
  return out;
}

function configuredCandidates() {
  const raw = process.env.FOOD_PHOTO_PROVIDER_CANDIDATES;
  if (raw == null || !String(raw).trim()) return defaultCandidates().filter(isConfigured);
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch {
    return [];
  }
  // An explicit entry must stand on its own: all three fields, no falling
  // back to FOOD_PHOTO_PROVIDER_* — a list that half-works is a list the admin
  // will believe is working.
  return parsed
    .map((entry) => ({
      provider: String(entry?.provider || '').trim().toLowerCase(),
      config: {
        baseUrl: String(entry?.baseUrl ?? '').trim(),
        apiKey: String(entry?.apiKey ?? '').trim(),
        model: String(entry?.model ?? '').trim(),
      },
    }))
    .filter(
      (c) =>
        (c.provider === 'gemini' || c.provider === 'openai') &&
        c.config.baseUrl &&
        c.config.apiKey &&
        c.config.model &&
        isConfigured(c),
    );
}

function isConfigured(candidate) {
  return candidate.provider === 'gemini'
    ? geminiVisionProvider.isConfigured(candidate.config)
    : openaiVisionProvider.isConfigured(candidate.config);
}

/** The configured rotation, in attempt order. Read per request: env is the config. */
export function candidates() {
  return configuredCandidates();
}

/**
 * One provider call, on the candidate this attempt is owed.
 *
 * The attempt is coerced here rather than trusted: it arrives as a multipart
 * string from a phone, and anything unusable falls back to candidate 1 — the
 * vendor a client that knows nothing about the rotation would have hit.
 */
export async function recognizeFood(payload, { attempt = 1 } = {}) {
  const chain = candidates();
  if (!chain.length) {
    throw new ProviderError('Food photo provider is not configured', {
      retryable: false,
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }
  const n = Math.trunc(Number(attempt));
  const index = ((Number.isFinite(n) && n >= 1 ? n : 1) - 1) % chain.length;
  const candidate = chain[index];
  if (candidate.provider === 'gemini') {
    return geminiVisionProvider.recognizeFood(payload, candidate.config);
  }
  return openaiVisionProvider.recognizeFood(payload, candidate.config);
}

/// Whether at least one candidate has an API key, a model and a base URL.
///
/// Surfaced separately from the `foodPhotoLogging` flag on purpose. The flag says
/// an admin has switched the feature on; this says there is somewhere for the
/// request to go. Those are different facts, and enabling the flag without a key
/// must produce a clear 503 rather than a provider error the app cannot explain.
export function isRecognizerConfigured() {
  try {
    return candidates().length > 0;
  } catch {
    return false;
  }
}
