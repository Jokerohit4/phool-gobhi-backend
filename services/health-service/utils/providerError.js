/// Raised by an outbound AI provider so the caller can tell "try again" from
/// "this will never work".
///
/// Copied here rather than imported from services/assistant/providers/index.js
/// because that file also owns the assistant's provider SELECTION, and a
/// nutrition route importing it would pull the assistant's env reads and its
/// production ollama guard along with it. This is the same class as the
/// assistant's, and the assistant's is unchanged - two copies of a four-field
/// error is a smell, but converging them is a refactor of working code and
/// belongs on its own, not inside a food-logging feature.
///
/// The distinction that matters, and the reason this is not a plain Error:
///
///   retryable: true   - the network blipped, the provider 5xx'd or 429'd. The
///                       same request has a real chance of succeeding, and for
///                       a paid vision call a retry is still usually cheaper
///                       than making the user photograph their plate again.
///   retryable: false  - the request itself is wrong, or the provider is not
///                       configured. Retrying spends money to fail identically,
///                       so the route must not offer "try again" for these.
export class ProviderError extends Error {
  constructor(message, { status, retryable = false, code } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

/// Whether a thrown value is one of ours, across the module boundary a
/// rethrown error can cross.
export function isProviderError(err) {
  return err?.name === 'ProviderError';
}
