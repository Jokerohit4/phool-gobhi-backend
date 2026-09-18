import { APP_MODES, TRAINING_LOCATION_PREFS } from '../constants/userEnums.js';

// Which experience the app leads with, derived from the onboarding answers.
//
// Derived server-side and never accepted from the client on the profile PATCH,
// so the rule lives in exactly one place. A user who wants a different mode
// than this produces changes it explicitly (PUT /users/:id/app-mode), which is
// a deliberate act we log — not a silent disagreement between two clients each
// computing the rule slightly differently.
//
// The product argument behind it, from the onboarding flow's own annotations:
// for someone who does not train yet, pay-per-session IS the proposition, so
// Home should sell it. For someone already training — at home, or at a gym we
// may not even have as a partner — it is not; that user wants a workout,
// progress and habit tool, and should merely be told PAYG exists.
export function deriveAppMode(user) {
  const { currentlyWorksOut, trainingLocationPref } = user || {};

  // Never asked. Returning null (rather than defaulting to gym_seeker) is what
  // lets every pre-existing account keep the current Home untouched until it
  // actually answers — the app's branch falls through on null.
  if (currentlyWorksOut === null || currentlyWorksOut === undefined) return null;

  // Doesn't train yet: PAYG is the proposition. This holds regardless of where
  // they said they'd PREFER to train — someone who isn't training at all needs
  // a reason to start more than they need a workout logger, and a booked
  // session with money attached is a stronger commitment device than a plan.
  if (currentlyWorksOut === false) return APP_MODES.GYM_SEEKER;

  // Already trains at home: nothing to book, so the app has to be the product.
  if (trainingLocationPref === TRAINING_LOCATION_PREFS.HOME) {
    return APP_MODES.HOME_TRACK;
  }

  // Already trains at a gym/fitness centre/elsewhere. gym_seeker, even when
  // that gym isn't a partner: this user has already demonstrated they'll walk
  // into a gym, which makes them far likelier to book a session than a
  // home-only user, and their Home should keep gym discovery in reach. What
  // changes for the non-partner case is attendance (GPS, no QR, no booking),
  // not which Home they see.
  if (trainingLocationPref) return APP_MODES.GYM_SEEKER;

  // Said yes but hasn't answered where yet — mid-onboarding. Leave it null
  // rather than guessing; the next PATCH re-derives with the full picture.
  return null;
}
