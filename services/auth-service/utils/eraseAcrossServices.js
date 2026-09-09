import { googleIdTokenHeader } from './googleIdToken.js';

const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Every service that stores personal data keyed to a user id. Booking and
// wallet are deliberately absent: neither denormalises any PII (they hold
// amounts, dates and gym ids), so once the User row here is gone their
// `customerId: 42` is already a pseudonymous integer pointing at nothing.
// Their rows are also part of a financial and partner-settlement record
// with statutory retention — deleting them would create a different legal
// problem than the one erasure solves.
const ERASURE_TARGETS = [
  { name: 'buddy-service', url: () => process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007' },
  { name: 'challenge-service', url: () => process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008' },
  { name: 'health-service', url: () => process.env.HEALTH_SERVICE_URL || 'http://health-service:5009' },
];

/// Erases this user everywhere except auth-service itself.
///
/// Deliberately NOT fire-and-forget, unlike the notify helpers in this
/// codebase. A dropped notification is a missed nudge; a dropped erasure is
/// personal data surviving a deletion request, which is the failure this
/// whole path exists to prevent. So every call is awaited, and the caller
/// is told exactly which services failed.
///
/// Returns { ok, results, failures } rather than throwing, so the caller can
/// decide the policy (see deleteUserService: it refuses to delete the User
/// row unless every downstream succeeded, leaving the account intact and
/// retryable instead of stranding unreachable orphan data).
export async function eraseUserAcrossServices(userId) {
  const results = [];
  const failures = [];

  for (const target of ERASURE_TARGETS) {
    const base = target.url();
    try {
      // fetch, not axios — this service has no axios dependency and uses
      // native fetch throughout (see fetchCustomerIdsWithActivity).
      const res = await fetch(`${base}/internal/erase/${userId}`, {
        method: 'POST',
        headers: {
          'x-internal-key': INTERNAL_API_KEY,
          'Content-Type': 'application/json',
          ...(await googleIdTokenHeader(base)),
        },
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        // A non-2xx — including a 404 meaning "erasure isn't deployed on
        // that service yet" — is a genuine failure to erase, not a benign
        // miss. It must not be swallowed the way an optional notify is.
        console.error(`erase: ${target.name} returned ${res.status} for user ${userId}`);
        failures.push({ service: target.name, status: res.status, error: `HTTP ${res.status}` });
        continue;
      }

      const body = await res.json().catch(() => ({}));
      results.push({ service: target.name, ...(body?.data ?? { erased: true }) });
    } catch (err) {
      console.error(`erase: ${target.name} failed for user ${userId}`, err.message);
      failures.push({ service: target.name, status: null, error: err.message });
    }
  }

  return { ok: failures.length === 0, results, failures };
}
