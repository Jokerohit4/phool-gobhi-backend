import { test } from 'node:test';
import assert from 'node:assert/strict';

// A profile in scripts/seedFeatureFlags.js is a safety claim about an
// environment: `all-off` is the incident kill switch, `consent-minimal` is the
// promise that nothing which collects personal data is reachable, and
// `launch-candidate` is a proposal that must not quietly grow a medical or
// consent-bearing flag. None of those are visible in a diff, and the CLI-level
// checks only prove the names parse - so the contents are asserted here.
//
// Nothing in this file touches a database. The write path (read-modify-write of
// the shared config blob, plus the audit row) can only be exercised against a
// real Postgres and is deliberately not mocked: a mocked transaction would
// assert that the code calls the calls it makes.

import { PROFILES } from '../scripts/seedFeatureFlags.js';
import { FEATURE_FLAGS, defaultFeatures, flagNames } from '../config/featureFlagRegistry.js';

const byName = new Map(FEATURE_FLAGS.map((f) => [f.name, f]));
const on = (name) => PROFILES[name].on();

test('every profile names only flags that exist in the registry', () => {
  // A typo here would be the exact silent failure the registry was built to
  // stop: an enable-list naming a flag that does not exist reads as a careful
  // posture and enables nothing.
  for (const name of Object.keys(PROFILES)) {
    for (const flag of on(name)) {
      assert.ok(
        byName.has(flag),
        `profile "${name}" enables "${flag}", which is not in the registry`
      );
    }
  }
});

test('every profile is a subset of the registry, never a superset', () => {
  for (const name of Object.keys(PROFILES)) {
    const unique = new Set(on(name));
    assert.equal(unique.size, on(name).length, `profile "${name}" lists a flag twice`);
  }
});

test('all-off is the kill switch: nothing on at all', () => {
  assert.deepEqual(on('all-off'), []);
});

test('defaults reproduces the registry defaults exactly', () => {
  const expected = flagNames().filter((n) => defaultFeatures()[n].enabled);
  assert.deepEqual(on('defaults').sort(), expected.sort());
});

test('all-on is the only profile that touches every flag', () => {
  // It is labelled local/dev only, because it includes the flags the registry
  // holds for legal sign-off (healthVault, cycleTracking, foodPhotoLogging,
  // fhirExport) and streaksCoins, whose own entry says not to enable it until
  // the coin sink exists.
  assert.deepEqual(on('all-on').sort(), flagNames().sort());
  for (const name of Object.keys(PROFILES)) {
    if (name === 'all-on') continue;
    assert.notDeepEqual(on(name).sort(), flagNames().sort(), `profile "${name}" should not be all-on`);
  }
});

test('consent-minimal only enables flags that collect nothing', () => {
  // badges is display-only: no ledger, no coin movement, and its registry entry
  // says it fails OPEN because showing it is harmless. Everything with a real
  // dataClass - health-derived, medical, training-log, social - is a collection
  // surface and must stay out of this profile.
  const collecting = new Set(
    FEATURE_FLAGS.filter((f) => f.dataClass !== 'none').map((f) => f.name)
  );
  for (const flag of on('consent-minimal')) {
    assert.equal(
      byName.get(flag).dataClass,
      'none',
      `consent-minimal enables "${flag}" (dataClass: ${byName.get(flag).dataClass}), which is not a no-data surface`
    );
  }
  assert.ok(collecting.size > 0, 'sanity: the registry should classify some flags as collecting data');
  assert.deepEqual(
    on('consent-minimal').filter((f) => collecting.has(f)),
    []
  );
});

test('launch-candidate matches the launch table in docs/FEATURE-FLAG-SPLIT.md §9', () => {
  // The profile is that table made executable, so the two must not drift. If
  // this fails, either the table moved (update this) or the profile did (update
  // the table) - but they cannot both be right and different.
  assert.deepEqual(on('launch-candidate').sort(), [
    'badges',
    'brandedOnboarding',
    'buddy',
    'healthMetrics',
    'homeTrackHome',
    'nonPartnerAttendance',
    'referral',
    'workoutTracking',
  ]);
});

test('launch-candidate enables no medical or AI surface', () => {
  // The whole point of the profile: the health SCORE ships, the consent-bearing
  // and medical collection does not. Each of these is off for a recorded reason
  // in the registry - legal sign-off, an unreviewed disclaimer, a photo leaving
  // the device, or an unvalidated export format.
  const withheld = [
    'healthVault',
    'healthLedger',
    'foodPhotoLogging',
    'cycleTracking',
    'fhirExport',
    'healthPersonalisation',
    'fitnessAssistant',
    'recapSharing',
    'runTracker',
  ];
  for (const flag of withheld) {
    assert.ok(!on('launch-candidate').includes(flag), `launch-candidate must not enable ${flag}`);
  }
});

test('launch-candidate does not rely on deps auto-enabling anything', () => {
  // `deps` makes a child INERT while its parent is off; it never switches a
  // child on. So healthMetrics being on must not be the reason any AI or
  // medical flag is on - if one of them appears in this profile it has to be
  // named deliberately, which the test above enforces.
  const healthDependents = FEATURE_FLAGS.filter((f) => f.deps.includes('healthMetrics')).map((f) => f.name);
  assert.ok(healthDependents.length >= 5, 'sanity: several flags depend on healthMetrics');
  const enabledDependents = on('launch-candidate').filter((f) => healthDependents.includes(f));
  assert.deepEqual(enabledDependents, [], 'only healthMetrics itself should be on among its dependents');
});

test('launch-candidate leaves the known-broken gamification flags off', () => {
  // streaksCoins has no coin sink yet (its registry entry says DO NOT ENABLE),
  // and buddyPairedStreaks keeps awarding coins for matches that no longer
  // exist because nothing re-checks match status on unmatch. Neither belongs in
  // a profile meant to describe a launch posture.
  for (const flag of ['streaksCoins', 'challenges', 'buddyPairedStreaks']) {
    assert.ok(!on('launch-candidate').includes(flag), `launch-candidate must not enable ${flag}`);
  }
});

test('launch-candidate keeps the two flags that are live in production', () => {
  // buddy and referral default ON precisely because they are already shipped -
  // turning them off in a launch profile would switch off a live feature.
  assert.ok(on('launch-candidate').includes('buddy'));
  assert.ok(on('launch-candidate').includes('referral'));
});

test('launch-candidate dependencies are satisfiable', () => {
  // A profile that enabled a flag while leaving its dependency off would ship a
  // toggle the admin portal renders as blocked, and the seed script's own plan
  // output would print "(inert: ...)" - a posture nobody chose on purpose.
  const enabled = new Set(on('launch-candidate'));
  for (const name of enabled) {
    for (const dep of byName.get(name).deps) {
      assert.ok(enabled.has(dep), `launch-candidate enables ${name} but not its dependency ${dep}`);
    }
  }
});
