import * as hostedProvider from './hostedProvider.js';
import * as ollamaProvider from './ollamaProvider.js';

/// Raised by a provider so the caller can tell "try again" from "this will
/// never work".
export class ProviderError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

const USING_OLLAMA = process.env.ASSISTANT_PROVIDER === 'ollama';

// Structurally impossible rather than merely discouraged.
//
// Ollama needs an always-on GPU or large-CPU host. This fleet is Cloud Run
// with min-instances=0, node:20-alpine, and no GPU anywhere — pointing prod at
// it would not be a cost decision, it would be an outage. Failing at boot
// makes that a deploy that never goes live, instead of a service that accepts
// traffic and times out every request.
if (USING_OLLAMA && process.env.NODE_ENV === 'production') {
  throw new Error(
    'ASSISTANT_PROVIDER=ollama is not usable in production: this fleet runs ' +
      'Cloud Run with min-instances=0 and no GPU. Use the hosted provider.'
  );
}

/// The one interface both implementations satisfy:
///   generate({ systemPrompt, messages, maxTokens, timeoutMs })
///     -> { content, tokensIn, tokensOut, model }
export function getProvider() {
  return USING_OLLAMA ? ollamaProvider : hostedProvider;
}
