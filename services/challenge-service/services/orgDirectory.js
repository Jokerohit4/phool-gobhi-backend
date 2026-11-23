import { googleIdTokenHeader } from '../utils/googleIdToken.js';

// Thin clients for the two other services corporate wellness depends on.
// Kept in one file so tests can mock the network boundary in one place.

const AUTH_SERVICE_URL = () => process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const HEALTH_SERVICE_URL = () => process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';

async function internalHeaders(base) {
  return {
    'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(),
    ...(await googleIdTokenHeader(base)),
  };
}

// 10-digit Indian mobile, identical to auth-service's normalizePhone so a phone
// staff paste here matches the account the user signed up with.
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

// id of the account that owns this phone, or null when nobody has signed up
// with it yet. A real failure throws so a member is never recorded as
// "invited" just because auth-service was briefly down.
export async function lookupUserIdByPhone(phone) {
  const base = AUTH_SERVICE_URL();
  const res = await fetch(`${base}/internal/by-phone/${phone}`, {
    headers: await internalHeaders(base),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw { status: 503, error: 'Could not reach the accounts service. Please try again.' };
  const body = await res.json();
  return Number.isInteger(Number(body?.id)) ? Number(body.id) : null;
}

// { [id]: { id, name, phone, leaderboardOptIn } } for the ids that exist.
export async function fetchUsersByIds(ids) {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!unique.length) return {};
  const base = AUTH_SERVICE_URL();
  const res = await fetch(`${base}/internal/users/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await internalHeaders(base)) },
    body: JSON.stringify({ ids: unique }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw { status: 503, error: 'Could not reach the accounts service. Please try again.' };
  const users = (await res.json())?.data ?? [];
  return Object.fromEntries(users.map((u) => [u.id, u]));
}

// Per-user activity for a window, from health-service:
//   { [userId]: { workoutDays: ['YYYY-MM-DD'], stepsByDay: { 'YYYY-MM-DD': n } } }
// Returns { data, complete }. `complete:false` means health-service could not
// answer, so the caller must not cache the (understated) result.
export async function fetchOrgActivity(userIds, fromDay, toDay) {
  const out = {};
  if (!userIds.length) return { data: out, complete: true };
  const base = HEALTH_SERVICE_URL();
  const headers = await internalHeaders(base);
  let complete = true;
  // The endpoint takes at most 500 ids per call.
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    try {
      const query = new URLSearchParams({ ids: chunk.join(','), from: fromDay, to: toDay });
      const res = await fetch(`${base}/internal/org-activity?${query}`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`org-activity ${res.status}`);
      Object.assign(out, (await res.json())?.data ?? {});
    } catch (_) {
      complete = false;
    }
  }
  return { data: out, complete };
}
