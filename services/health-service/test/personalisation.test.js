// FR-25/26/27. The point of these tests is that personalisation actually
// CHANGES the engine's output rather than just sitting in a table: injury
// zones mark groups limited, recovery mode stretches windows and suppresses
// PR pushes, and mode weights re-rank which saved routine surfaces.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let profile = null;
let sessionExercises = [];
let templates = [];

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

let getMuscleReadinessService;
let setProgrammingModeService, upsertProfileService, getProfileService, updateTrainingLocationService;

test('setup: mock prisma once, import the services once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.sessionExercise = { findMany: async () => sessionExercises };
          this.workoutTemplate = { findMany: async () => templates };
          this.workoutSession = { findMany: async () => [] };
          this.workoutSet = { findMany: async () => [] };
          this.personalisationProfile = {
            findUnique: async () => profile,
            upsert: async ({ create, update }) => {
              profile = profile ? { ...profile, ...update } : { injuryZones: [], ...create };
              return profile;
            },
            deleteMany: async () => { profile = null; },
          };
        }
      },
      Prisma: {},
    },
  });
  ({ getMuscleReadinessService } = await import('../services/progressService.js'));
  ({ setProgrammingModeService, upsertProfileService, getProfileService, updateTrainingLocationService } = await import(
    '../services/personalisationService.js'
  ));
  assert.equal(typeof getMuscleReadinessService, 'function');
});

test('no profile at all -> neutral mode, nothing suppressed', async () => {
  profile = null;
  sessionExercises = [];
  templates = [];

  const result = await getMuscleReadinessService(1);
  assert.equal(result.programmingMode, 'neutral');
  assert.equal(result.suppressPrPush, false);
  assert.ok(result.readiness.every((r) => r.status === 'ready'), 'never-trained groups are ready');
});

test('an injury zone marks its groups limited, not recovering', async () => {
  profile = { programmingMode: 'neutral', injuryZones: ['knee'] };
  sessionExercises = [];
  templates = [];

  const result = await getMuscleReadinessService(1);
  const legs = result.readiness.find((r) => r.muscleGroup === 'legs');
  const chest = result.readiness.find((r) => r.muscleGroup === 'chest');
  assert.equal(legs.status, 'limited', 'a knee chip steers volume away from legs');
  assert.equal(chest.status, 'ready', 'unrelated groups are untouched');
});

test('recovery mode stretches the window, so a recently-trained group stays recovering', async () => {
  // Chest trained 2 days ago: exactly at its neutral 2-day window (ready),
  // but under recovery mode's 1.5x window (3 days) it is not.
  sessionExercises = [
    { exercise: { muscleGroup: 'chest' }, session: { startedAt: daysAgo(2) } },
  ];
  templates = [];

  profile = { programmingMode: 'neutral', injuryZones: [] };
  const neutral = await getMuscleReadinessService(1);
  assert.equal(neutral.readiness.find((r) => r.muscleGroup === 'chest').status, 'ready');

  profile = { programmingMode: 'low_impact_recovery', injuryZones: [] };
  const recovery = await getMuscleReadinessService(1);
  assert.equal(recovery.readiness.find((r) => r.muscleGroup === 'chest').status, 'recovering');
  assert.equal(recovery.suppressPrPush, true, 'recovery mode must tell the client not to push PRs');
});

test('female_default re-ranks toward the lower-body routine', async () => {
  sessionExercises = [];
  templates = [
    {
      id: 1,
      name: 'Upper Day',
      exercises: [
        { exercise: { muscleGroup: 'chest' } },
        { exercise: { muscleGroup: 'shoulders' } },
      ],
    },
    {
      id: 2,
      name: 'Lower Day',
      exercises: [
        { exercise: { muscleGroup: 'legs' } },
        { exercise: { muscleGroup: 'core' } },
      ],
    },
  ];

  // Neutral: both routines are all-ready, so the first one wins on a tie.
  profile = { programmingMode: 'neutral', injuryZones: [] };
  const neutral = await getMuscleReadinessService(1);
  assert.equal(neutral.suggestedTemplate.id, 1);

  // female_default weights legs/core above 1.0, breaking the tie the other way.
  profile = { programmingMode: 'female_default', injuryZones: [] };
  const female = await getMuscleReadinessService(1);
  assert.equal(female.suggestedTemplate.id, 2, 'lower-body emphasis should surface Lower Day');
});

test('a routine built entirely on a limited group loses, but is still returned if it is all there is', async () => {
  sessionExercises = [];
  profile = { programmingMode: 'neutral', injuryZones: ['knee'] };
  templates = [
    { id: 5, name: 'Leg Day', exercises: [{ exercise: { muscleGroup: 'legs' } }] },
  ];

  const result = await getMuscleReadinessService(1);
  assert.equal(result.suggestedTemplate.id, 5, 'never hide the only routine the user has');
});

test('enabling a personalised mode without a privacyVersion is rejected', async () => {
  profile = null;
  await assert.rejects(
    () => setProgrammingModeService(1, 'low_impact_recovery'),
    /privacyVersion is required/,
  );
});

test('enabling a personalised mode records consent; going neutral clears it', async () => {
  profile = null;
  const enabled = await setProgrammingModeService(1, 'female_default', 'v1');
  assert.equal(enabled.programmingMode, 'female_default');
  assert.ok(enabled.consentAt);
  assert.equal(enabled.privacyVersion, 'v1');

  // Withdrawing is always frictionless — no consent version needed, and the
  // consent record goes with it.
  const neutral = await setProgrammingModeService(1, 'neutral');
  assert.equal(neutral.programmingMode, 'neutral');
  assert.equal(neutral.consentAt, null);
  assert.equal(neutral.privacyVersion, null);
});

test('a skipped setup reads back as an empty profile, not a 404', async () => {
  profile = null;
  const empty = await getProfileService(7);
  assert.equal(empty.heightCm, null);
  assert.equal(empty.programmingMode, 'neutral');
  assert.deepEqual(empty.injuryZones, []);
});

test('Step A and Step B save independently without wiping each other', async () => {
  profile = null;
  await upsertProfileService(1, { heightCm: 175 });
  await upsertProfileService(1, { injuryZones: ['shoulder'] });

  assert.equal(profile.heightCm, 175, 'Step B must not wipe Step A');
  assert.deepEqual(profile.injuryZones, ['shoulder']);
});

// H-19 (docs/../sprint2/PG-HUNT-001). trainingLocation is deliberately a
// SEPARATE write path from upsertProfileService above — it must never touch
// consentAt/privacyVersion, unlike setProgrammingModeService, because it's a
// UI-routing preference, not a disclosure someone is consenting to.
test('setting trainingLocation never touches consentAt or privacyVersion', async () => {
  profile = null;
  const updated = await updateTrainingLocationService(1, 'home');

  assert.equal(updated.trainingLocation, 'home');
  assert.equal(updated.consentAt, undefined);
  assert.equal(updated.privacyVersion, undefined);
});

test('trainingLocation can change independently of an existing programming mode', async () => {
  profile = null;
  await setProgrammingModeService(1, 'female_default', 'v1');
  const updated = await updateTrainingLocationService(1, 'both');

  assert.equal(updated.trainingLocation, 'both');
  // The consent recorded for the programming mode survives untouched — this
  // write path only ever sets one field.
  assert.equal(updated.programmingMode, 'female_default');
  assert.ok(updated.consentAt);
});
