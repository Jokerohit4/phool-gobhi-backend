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
