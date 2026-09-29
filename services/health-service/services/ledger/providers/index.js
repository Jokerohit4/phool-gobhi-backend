import * as geminiVisionProvider from './geminiVisionProvider.js';

// Provider selection for food-photo recognition.
//
// One implementation today, and the indirection is not speculative: it is the
// same reason services/assistant/providers/index.js exists. When the vision
// vendor changes - and with a Zero Data Retention question still open on the
// current one, "when" is more likely than "if" - this is the file that changes,
// and foodPhotoService.js never learns the name of the vendor it is talking to.
//
// Unlike the assistant's selector, there is no local fallback, because unlike the
// assistant there is no small model that can look at a photo of food. An
// unconfigured recogniser therefore reports itself unavailable and the route
// returns 503, which is a state the app can explain, rather than guessing at
// foods with no image model behind it.

export { ProviderError, isProviderError } from '../../../utils/providerError.js';

const PROVIDERS = {
  gemini: geminiVisionProvider,
};

const SELECTED = (process.env.FOOD_PHOTO_PROVIDER || 'gemini').trim().toLowerCase();

export function getRecognizer() {
  const provider = PROVIDERS[SELECTED];
  if (!provider) {
    throw new Error(
      `Unknown FOOD_PHOTO_PROVIDER '${SELECTED}'. Known: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return provider;
}

/// Whether the active provider has an API key, a model and a base URL.
///
/// Surfaced separately from the `foodPhotoLogging` flag on purpose. The flag says
/// an admin has switched the feature on; this says there is somewhere for the
/// request to go. Those are different facts, and enabling the flag without a key
/// must produce a clear 503 rather than a provider error the app cannot explain.
export function isRecognizerConfigured() {
  try {
    return getRecognizer().isConfigured();
  } catch {
    return false;
  }
}
