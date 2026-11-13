// The onboarding branch rule (services/appModeService.js). This decides which
// Home every customer sees, so the table below is the specification — if a
// case here changes, a real user's app changes shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveAppMode } from '../services/appModeService.js';
import { APP_MODES, TRAINING_LOCATION_PREFS } from '../constants/userEnums.js';

test('unanswered stays null so existing accounts are untouched', () => {
  // The important one: every account that predates this feature has
  // currentlyWorksOut = null, and must keep the Home it has today. A default
  // of gym_seeker here would silently re-shape the app for the whole userbase
  // on deploy.
  assert.equal(deriveAppMode({}), null);
  assert.equal(deriveAppMode({ currentlyWorksOut: null }), null);
  assert.equal(deriveAppMode(null), null);
  assert.equal(deriveAppMode(undefined), null);
});

test('does not work out -> gym_seeker only when gym discovery is the preference', () => {
  // Explicit non-gym choices lead to the training product. An unanswered
  // location retains the discovery default until the user chooses a path.
  for (const pref of [
    undefined,
    null,
    TRAINING_LOCATION_PREFS.GYM,
  ]) {
    assert.equal(
      deriveAppMode({ currentlyWorksOut: false, trainingLocationPref: pref }),
      APP_MODES.GYM_SEEKER,
      `currentlyWorksOut=false, pref=${pref}`,
    );
  }
  assert.equal(
    deriveAppMode({ currentlyWorksOut: false, trainingLocationPref: TRAINING_LOCATION_PREFS.HOME }),
    APP_MODES.HOME_TRACK,
  );
  for (const pref of [
    TRAINING_LOCATION_PREFS.FITNESS_CENTRE,
    TRAINING_LOCATION_PREFS.SPORTS,
    TRAINING_LOCATION_PREFS.OTHER,
  ]) {
    assert.equal(
      deriveAppMode({ currentlyWorksOut: false, trainingLocationPref: pref }),
      APP_MODES.HOME_TRACK,
      `currentlyWorksOut=false, pref=${pref}`,
    );
  }
});

test('trains at home -> home_track', () => {
  assert.equal(
    deriveAppMode({ currentlyWorksOut: true, trainingLocationPref: TRAINING_LOCATION_PREFS.HOME }),
    APP_MODES.HOME_TRACK,
  );
});

test('trains at a gym/centre/sports/elsewhere -> home_track if they have a gym, gym_seeker if they do not', () => {
  // A bare "gym" / "fitness_centre" preference without a linked or claimed gym
  // means they don't actually have one to track at — they're a seeker.
  for (const pref of [
    TRAINING_LOCATION_PREFS.GYM,
    TRAINING_LOCATION_PREFS.FITNESS_CENTRE,
  ]) {
    assert.equal(
      deriveAppMode({ currentlyWorksOut: true, trainingLocationPref: pref }),
      APP_MODES.GYM_SEEKER,
      `pref=${pref}, no gym linked`,
    );
    assert.equal(
      deriveAppMode({ currentlyWorksOut: true, trainingLocationPref: pref, linkedGymId: 42 }),
      APP_MODES.HOME_TRACK,
      `pref=${pref}, linked gym`,
    );
    assert.equal(
      deriveAppMode({ currentlyWorksOut: true, trainingLocationPref: pref, homeUnclaimedGymId: 7 }),
      APP_MODES.HOME_TRACK,
      `pref=${pref}, claimed gym`,
    );
  }
  // Sports and other preferences are not gym-seeking; they keep the training product.
  for (const pref of [
    TRAINING_LOCATION_PREFS.SPORTS,
    TRAINING_LOCATION_PREFS.OTHER,
  ]) {
    assert.equal(
      deriveAppMode({ currentlyWorksOut: true, trainingLocationPref: pref }),
      APP_MODES.HOME_TRACK,
      `pref=${pref}`,
    );
  }
});

test('mid-onboarding (yes, but no location yet) stays null', () => {
  // Answers arrive across more than one PATCH. Guessing here would flip the
  // user into a mode on the first call and out of it on the second, which the
  // app would render as Home changing under them mid-signup.
  assert.equal(deriveAppMode({ currentlyWorksOut: true }), null);
  assert.equal(deriveAppMode({ currentlyWorksOut: true, trainingLocationPref: null }), null);
});

test('linked gym matters only for gym-type preferences', () => {
  // HOME preference is unaffected by gym links.
  const base = { currentlyWorksOut: true, trainingLocationPref: TRAINING_LOCATION_PREFS.HOME };
  assert.equal(deriveAppMode({ ...base, linkedGymId: 42, name: 'x' }), APP_MODES.HOME_TRACK);

  // Gym preference: no gym → seeker, with gym → home_track.
  const gymBase = { currentlyWorksOut: true, trainingLocationPref: TRAINING_LOCATION_PREFS.GYM };
  assert.equal(deriveAppMode(gymBase), APP_MODES.GYM_SEEKER);
  assert.equal(deriveAppMode({ ...gymBase, linkedGymId: 42 }), APP_MODES.HOME_TRACK);
  assert.equal(deriveAppMode({ ...gymBase, homeUnclaimedGymId: 7 }), APP_MODES.HOME_TRACK);
});
