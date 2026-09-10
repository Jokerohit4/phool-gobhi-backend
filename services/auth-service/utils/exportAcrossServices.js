import { googleIdTokenHeader } from './googleIdToken.js';

const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Every service that holds personal data keyed to a user id.
//
// This list is deliberately LONGER than eraseAcrossServices' ERASURE_TARGETS,
// and the difference is the whole design. Booking, wallet and gym data is
// never erased — it is a financial and partner-settlement record with
// statutory retention, plus public review content — but data we keep is
// precisely the data a person is most entitled to see. An access right that
// covered only the data we were willing to delete would be backwards.
const EXPORT_TARGETS = [
  { name: 'buddy-service', key: 'gymBuddy', url: () => process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007' },
  { name: 'challenge-service', key: 'rewardsAndChallenges', url: () => process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008' },
  { name: 'health-service', key: 'healthAndTraining', url: () => process.env.HEALTH_SERVICE_URL || 'http://health-service:5009' },
  { name: 'booking-service', key: 'bookings', url: () => process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005' },
  { name: 'wallet-service', key: 'walletAndPayments', url: () => process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003' },
  { name: 'gym-service', key: 'reviewsYouWrote', url: () => process.env.GYM_SERVICE_URL || 'http://gym-service:5004' },
];

/// Collects this user's data from every service except auth-service itself.
///
/// Unlike erasure, a partial result here is still worth returning: a person
/// who asks what we hold about them is better served by five sections plus an
/// honest note about the sixth than by an error page. So failures are
/// reported inside the document rather than thrown — but they ARE reported,
/// prominently, because a silently missing section would misrepresent the
/// export as complete when it isn't.
///
/// Returns { sections, failures }.
export async function exportUserAcrossServices(userId) {
  // Fan out in parallel: these are independent reads with no ordering
  // constraint, unlike the erasure path where ordering is load-bearing.
  const settled = await Promise.all(
    EXPORT_TARGETS.map(async (target) => {
      const base = target.url();
      try {
        // fetch, not axios — this service has no axios dependency and uses
        // native fetch throughout.
        const res = await fetch(`${base}/internal/export/${userId}`, {
          method: 'GET',
          headers: {
            'x-internal-key': INTERNAL_API_KEY,
            'Content-Type': 'application/json',
            ...(await googleIdTokenHeader(base)),
          },
          signal: AbortSignal.timeout(20000),
        });

        if (!res.ok) {
          console.error(`export: ${target.name} returned ${res.status} for user ${userId}`);
          return { target, error: `HTTP ${res.status}` };
        }

        const body = await res.json().catch(() => ({}));
        return { target, data: body?.data ?? {} };
      } catch (err) {
        console.error(`export: ${target.name} failed for user ${userId}`, err.message);
        return { target, error: err.message };
      }
    }),
  );

  const sections = {};
  const failures = [];
  for (const result of settled) {
    if (result.error) {
      failures.push({ service: result.target.name, error: result.error });
      sections[result.target.key] = {
        unavailable: true,
        note: 'This section could not be retrieved. Nothing has been deleted — please request the export again.',
      };
      continue;
    }
    sections[result.target.key] = result.data;
  }

  return { sections, failures };
}
