import { googleIdTokenHeader } from './googleIdToken.js';

const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// The services that expose a person to OTHER users and so must hide them when
// an account is archived. This is the retain-everything counterpart of
// eraseAcrossServices: nothing is deleted anywhere.
//
//  - buddy-service: the profile, photos and chats are visible to other members, so
//    the profile is taken out of every deck and the person's matches end.
//
// Deliberately absent, because they show nothing of the person to anyone else:
//  - challenge-service and health-service key everything on the user id and keep no
//    name or photo copy; a leaderboard resolves the name from auth at read time, and
//    auth neutralises it.
//  - booking, wallet and gym-service likewise hold only ids (a review shows the
//    reviewer's name, resolved from auth at read time).
const ARCHIVE_TARGETS = [
  { name: 'buddy-service', url: () => process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007' },
];

/// Hides this user from other people, everywhere it matters. Like the erase
/// fan-out, this is awaited, not fire-and-forget: a dropped hide would leave an
/// archived person's photos and bio visible in someone else's deck, so the caller
/// is told exactly which services failed and refuses to archive the account until
/// all succeed (every call is idempotent, so the user can simply retry).
export async function archiveUserAcrossServices(userId) {
  const results = [];
  const failures = [];

  for (const target of ARCHIVE_TARGETS) {
    const base = target.url();
    try {
      const res = await fetch(`${base}/internal/archive/${userId}`, {
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
        console.error(`archive: ${target.name} returned ${res.status} for user ${userId}`);
        failures.push({ service: target.name, status: res.status, error: `HTTP ${res.status}` });
        continue;
      }

      const body = await res.json().catch(() => ({}));
      results.push({ service: target.name, ...(body?.data ?? { archived: true }) });
    } catch (err) {
      console.error(`archive: ${target.name} failed for user ${userId}`, err.message);
      failures.push({ service: target.name, status: null, error: err.message });
    }
  }

  return { ok: failures.length === 0, results, failures };
}
