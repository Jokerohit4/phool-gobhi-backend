import { APP_MODES, TRAINING_LOCATION_PREFS } from '../constants/userEnums.js';

// Which experience the app leads with, derived from the onboarding answers.
//
// Derived server-side and never accepted from the client on the profile PATCH,
// so the rule lives in exactly one place. A user who wants a different mode
// than this produces changes it explicitly (PUT /users/:id/app-mode), which is
// a deliberate act we log — not a silent disagreement between two clients each
// computing the rule slightly differently.
//
// The user's explicit workout intent wins. Wellness is its own experience;
// home_track remains the workout/progress product, and gym_seeker leads with
// booking/PAYG for people who want to start at a gym.
export function deriveAppMode(user) {
  const {
    currentlyWorksOut,
    trainingLocationPref,
    workoutIntent,
    wellnessFocuses,
    wellnessDayPattern,
    wellnessSleepPattern,
    wellnessSetupCompleted,
  } = user || {};

  // Wellness-only answers can survive independently on older/incomplete
  // profiles where workoutIntent was never written. Keep the separate mode
  // derived from any explicit wellness setup signal.
  if (
    workoutIntent === 'wellness_only'
    || wellnessSetupCompleted === true
    || (Array.isArray(wellnessFocuses) && wellnessFocuses.length > 0)
    || wellnessDayPattern != null
    || wellnessSleepPattern != null
  ) return APP_MODES.WELLNESS;

  // Never asked. Returning null (rather than defaulting to gym_seeker) is what
  // lets every pre-existing account keep the current Home untouched until it
  // actually answers — the app's branch falls through on null.
  if (currentlyWorksOut === null || currentlyWorksOut === undefined) return null;

  // Doesn't train yet. Someone who wants to start at a partner gym gets the
  // marketplace: PAYG is the proposition, and a booked session with money
  // attached is a stronger commitment device than a plan.
  if (currentlyWorksOut === false) {
    // Only people who explicitly choose a gym should be sent into gym
    // discovery. Home, fitness-centre, sports, and other preferences use the
    // training product without defaulting to a gym marketplace.
    return trainingLocationPref && trainingLocationPref !== TRAINING_LOCATION_PREFS.GYM
      ? APP_MODES.HOME_TRACK
      : APP_MODES.GYM_SEEKER;
  }

  // Already trains at home: nothing to book, so the app has to be the product.
  if (trainingLocationPref === TRAINING_LOCATION_PREFS.HOME) {
    return APP_MODES.HOME_TRACK;
  }

  // Already trains at a gym/fitness centre/elsewhere: they already have a gym
  // habit, so the app should be a workout/helping tool first (log visits,
  // track progress, routines), not a marketplace. Discovery remains available
  // (demoted to the bottom of home_track) for when/if they want to try partner
  // gyms; the attendance case for their own gym is handled via "Check in at
  // your gym" (non-partner attendance).
  if (trainingLocationPref) return APP_MODES.HOME_TRACK;

  // Said yes but hasn't answered where yet — mid-onboarding. Leave it null
  // rather than guessing; the next PATCH re-derives with the full picture.
  return null;
}
