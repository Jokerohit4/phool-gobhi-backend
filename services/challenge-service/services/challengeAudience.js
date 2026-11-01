import { googleIdTokenHeader } from '../utils/googleIdToken.js';

export const AUDIENCES = ['wellness', 'home_training', 'own_gym', 'linked_gym', 'explorer'];

// auth-service owns the persona now (services/personaService.js) and serves it
// resolved on /internal/:id. The derivation below is only the fallback for an
// auth-service that predates that field; keep it until every environment runs
// one that sends `persona`.
export function audienceForProfile(profile) {
  if (AUDIENCES.includes(profile.persona)) return profile.persona;
  if (profile.linkedGymId != null) return 'linked_gym';
  if (profile.homeUnclaimedGymId != null) return 'own_gym';
  if (profile.workoutIntent === 'wellness_only' || profile.appMode === 'wellness' ||
      profile.wellnessSetupCompleted || profile.wellnessFocuses?.length ||
      profile.wellnessDayPattern || profile.wellnessSleepPattern) return 'wellness';
  if (['gym', 'fitness_centre'].includes(profile.trainingLocationPref)) return 'own_gym';
  if (profile.appMode === 'home_track' || profile.currentlyWorksOut === true ||
      ['home', 'sports', 'other'].includes(profile.trainingLocationPref)) return 'home_training';
  return 'explorer';
}

export async function loadChallengeAudience(userId) {
  const base = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
  try {
    const response = await fetch(`${base}/internal/${userId}`, {
      headers: { 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(), ...await googleIdTokenHeader(base) },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Profile ${response.status}`);
    const profile = await response.json();
    if (Number(profile?.id) !== Number(userId)) throw new Error('Invalid profile');
    return audienceForProfile(profile);
  } catch (_) {
    throw { status: 503, error: 'Could not load your challenge preferences. Please try again.' };
  }
}

// Read paths (the challenge list and detail screens) only use the audience to
// FILTER what they show, so a few seconds of staleness after a persona switch
// is harmless, and the list screen asks for it on every open — each time paying
// an auth-service round trip (with an ID-token header) before touching the DB.
// Cache it briefly per user and share one in-flight lookup. Enrolling does NOT
// use this: it decides what a user may join, so it always reads fresh.
// Failures are never cached. TTL 0 under `node --test`.
const AUDIENCE_CACHE_TTL_MS =
  process.env.NODE_TEST_CONTEXT && process.env.CHALLENGE_CACHE_FORCE !== '1' ? 0 : 15_000;
const AUDIENCE_CACHE_MAX = 2000;
const audienceCache = new Map(); // userId -> { value, expiresAt }
const audienceInFlight = new Map(); // userId -> Promise

export function loadChallengeAudienceCached(userId) {
  if (!(AUDIENCE_CACHE_TTL_MS > 0)) return loadChallengeAudience(userId);
  const key = Number(userId);
  const hit = audienceCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);
  const running = audienceInFlight.get(key);
  if (running) return running;
  const promise = loadChallengeAudience(userId)
    .then((value) => {
      if (audienceCache.size >= AUDIENCE_CACHE_MAX) audienceCache.delete(audienceCache.keys().next().value);
      audienceCache.set(key, { value, expiresAt: Date.now() + AUDIENCE_CACHE_TTL_MS });
      return value;
    })
    .finally(() => audienceInFlight.delete(key));
  audienceInFlight.set(key, promise);
  return promise;
}

export function isPersonalChallenge(challenge) {
  return challenge.challengeDefinition?.defaultVerificationMethod === 'activity_log';
}

export function challengeMatchesAudience(challenge, audience) {
  if (!audience) return true; // Internal callers predating personalization.
  const definition = challenge.challengeDefinition;
  const audiences = definition?.audiences ?? [];
  if (audiences.length) return audiences.includes(audience);
  if (definition?.category === 'gym_native') return ['linked_gym', 'explorer'].includes(audience);
  return true; // Map adventures remain open to every kind of user.
}
