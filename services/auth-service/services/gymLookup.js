// Existence checks against gym-service, used before a persona switch (or a
// link) points a user at a gym.

import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';

// { found: gym } | { found: null } (gym-service said no) | { unknown: true }
async function lookup(path, gymId) {
  try {
    const res = await fetch(`${GYM_SERVICE_URL}${path}`, {
      headers: {
        'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(),
        ...(await googleIdTokenHeader(GYM_SERVICE_URL)),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return { found: null };
    if (!res.ok) return { unknown: true };
    const body = await res.json();
    const gym = body?.data ?? body;
    if (!gym || gym.id == null) return { unknown: true };
    return { found: Number(gym.id) === Number(gymId) ? gym : null };
  } catch (_) {
    return { unknown: true };
  }
}

// Strict lookups for a persona switch: a null return means "no such gym" and
// also "gym-service unreachable", deliberately — refusing a switch is
// recoverable, pointing a user (and a partner's bill) at a gym that may not
// exist is not.

/** A partner gym: `{ id, isApproved, ... }` or null. */
export async function findPartnerGym(gymId) {
  return (await lookup(`/internal/${gymId}`, gymId)).found ?? null;
}

/** A non-partner (Places-sourced) gym: `{ id, ... }` or null. */
export async function findUnclaimedGym(gymId) {
  return (await lookup(`/internal/unclaimed-gyms/${gymId}`, gymId)).found ?? null;
}

export const gymLookupDeps = { partnerGym: findPartnerGym, unclaimedGym: findUnclaimedGym };

// Lenient checks for paths that must never fail on a gym-service blip (the
// QR join at login, onboarding saves): false only when gym-service positively
// says no.

/** The QR join path: a real, approved partner gym. */
export async function isLinkablePartnerGym(gymId) {
  const r = await lookup(`/internal/${gymId}`, gymId);
  if (r.unknown) return true;
  return Boolean(r.found) && r.found.isApproved !== false;
}

/** A homeUnclaimedGymId the user is saving: an existing UnclaimedGym. */
export async function isKnownUnclaimedGym(gymId) {
  const r = await lookup(`/internal/unclaimed-gyms/${gymId}`, gymId);
  return r.unknown ? true : Boolean(r.found);
}
