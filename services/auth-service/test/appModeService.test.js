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

test('does not work out -> gym_seeker, whatever they would prefer', () => {
  // PAYG is the proposition for someone who isn't training yet, including
  // someone who says they'd prefer to train at home.
  for (const pref of [undefined, null, ...Object.values(TRAINING_LOCATION_PREFS)]) {
    assert.equal(
      deriveAppMode({ currentlyWorksOut: false, trainingLocationPref: pref }),
      APP_MODES.GYM_SEEKER,
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

test('trains at a gym/centre/elsewhere -> gym_seeker', () => {
  for (const pref of [
    TRAINING_LOCATION_PREFS.GYM,
    TRAINING_LOCATION_PREFS.FITNESS_CENTRE,
    TRAINING_LOCATION_PREFS.OTHER,
  ]) {
    assert.equal(
      deriveAppMode({ currentlyWorksOut: true, trainingLocationPref: pref }),
      APP_MODES.GYM_SEEKER,
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

test('is a pure function of its two inputs', () => {
  // Guards against someone later reaching for linkedGymId or a gym pick here:
  // those belong to attendance and discovery, not to which Home leads.
  const base = { currentlyWorksOut: true, trainingLocationPref: TRAINING_LOCATION_PREFS.HOME };
  assert.equal(deriveAppMode({ ...base, linkedGymId: 42, name: 'x' }), APP_MODES.HOME_TRACK);
});
