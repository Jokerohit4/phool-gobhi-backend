// FR-25/26/27. The point of these tests is that personalisation actually
// CHANGES the engine's output rather than just sitting in a table: injury
// zones mark groups limited, recovery mode stretches windows and suppresses
// PR pushes, and mode weights re-rank which saved routine surfaces.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let profile = null;
let cycleProfile = null;
let sessionExercises = [];
let templates = [];

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

let getMuscleReadinessService;
let setProgrammingModeService, upsertProfileService, getProfileService;

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
            updateMany: async ({ data }) => {
              profile = profile ? { ...profile, ...data } : null;
              return { count: profile ? 1 : 0 };
            },
            deleteMany: async () => { profile = null; },
          };
          // Read by progressService's lazy expiry of a cycle-owned recovery
          // mode (releaseExpiredRecoveryMode). Null unless a test opts in.
          this.cycleTrackingProfile = { findUnique: async () => cycleProfile };
        }
      },
      Prisma: {},
    },
  });
  ({ getMuscleReadinessService } = await import('../services/progressService.js'));
  ({ setProgrammingModeService, upsertProfileService, getProfileService } = await import(
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
  cycleProfile = null;

  profile = { programmingMode: 'neutral', injuryZones: [] };
  const neutral = await getMuscleReadinessService(1);
  assert.equal(neutral.readiness.find((r) => r.muscleGroup === 'chest').status, 'ready');

  profile = { programmingMode: 'low_impact_recovery', injuryZones: [] };
  const recovery = await getMuscleReadinessService(1);
  assert.equal(recovery.readiness.find((r) => r.muscleGroup === 'chest').status, 'recovering');
  assert.equal(recovery.suppressPrPush, true, 'recovery mode must tell the client not to push PRs');
});

test('a cycle recovery mode whose window has closed lapses to neutral in readiness', async () => {
  // The expiry is read-side: no cron needed. A low_impact the cycle sync set
  // during the last period must not keep stretching windows weeks later.
  sessionExercises = [];
  templates = [];
  profile = { programmingMode: 'low_impact_recovery', injuryZones: [] };
  cycleProfile = {
    userId: 1,
    managesProgrammingMode: true,
    lastPeriodStartDate: new Date(daysAgo(20)),
  };

  const result = await getMuscleReadinessService(1);
  assert.equal(result.programmingMode, 'neutral', 'an owned, expired override is released');
  assert.equal(result.suppressPrPush, false);
  assert.equal(profile.programmingMode, 'neutral', 'the stored mode is cleared, not just the copy');
});

test('a cycle recovery mode inside its window keeps low-impact in readiness', async () => {
  sessionExercises = [
    { exercise: { muscleGroup: 'chest' }, session: { startedAt: daysAgo(2) } },
  ];
  templates = [];
  profile = { programmingMode: 'low_impact_recovery', injuryZones: [] };
  cycleProfile = { userId: 1, managesProgrammingMode: true, lastPeriodStartDate: new Date(daysAgo(0)) };

  const result = await getMuscleReadinessService(1);
  assert.equal(result.programmingMode, 'low_impact_recovery');
  assert.equal(result.suppressPrPush, true);
});

test('a user-chosen low-impact is not expired by the cycle window', async () => {
  // managesProgrammingMode distinguishes our programmatic override from the
  // user's own choice (typically injury). Hers is never auto-expired.
  sessionExercises = [];
  templates = [];
  profile = { programmingMode: 'low_impact_recovery', injuryZones: ['knee'] };
  cycleProfile = { userId: 1, managesProgrammingMode: false, lastPeriodStartDate: new Date(daysAgo(20)) };

  const result = await getMuscleReadinessService(1);
  assert.equal(result.programmingMode, 'low_impact_recovery');
  assert.equal(result.suppressPrPush, true);
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

// Home setup (onboarding audit P2): the suggestion engine must actually use
// it, not just store it.
test('a routine needing kit the user lacks is passed over for one that fits', async () => {
  sessionExercises = [];
  templates = [
    { id: 7, name: 'Dumbbell Upper', exercises: [
      { exercise: { muscleGroup: 'chest', equipment: 'dumbbell' } },
    ] },
    { id: 8, name: 'Bodyweight Upper', exercises: [
      { exercise: { muscleGroup: 'chest', equipment: 'bodyweight' } },
    ] },
  ];
  profile = { programmingMode: 'neutral', injuryZones: [], homeSetupAt: new Date(), homeEquipment: ['none'] };
  const result = await getMuscleReadinessService(1);
  assert.equal(result.suggestedTemplate.id, 8, 'no dumbbells at home, so not the dumbbell routine');

  // Unknown setup: the original tie-break (first wins) is untouched.
  profile = { programmingMode: 'neutral', injuryZones: [] };
  assert.equal((await getMuscleReadinessService(1)).suggestedTemplate.id, 7);
});

test('if nothing fits, the routine is still suggested rather than hidden', async () => {
  sessionExercises = [];
  templates = [
    { id: 9, name: 'Dumbbell Upper', exercises: [
      { exercise: { muscleGroup: 'chest', equipment: 'dumbbell' } },
    ] },
  ];
  profile = { programmingMode: 'neutral', injuryZones: [], homeSetupAt: new Date(), homeEquipment: ['none'] };
  assert.equal((await getMuscleReadinessService(1)).suggestedTemplate.id, 9);
});

test('saving any home-setup answer (or skipping) stamps homeSetupAt', async () => {
  profile = null;
  const saved = await upsertProfileService(1, { homeEquipment: [] });
  assert.ok(saved.homeSetupAt instanceof Date, '"I have nothing" is an answer');

  profile = null;
  const skipped = await upsertProfileService(1, { homeSetupAnswered: true });
  assert.ok(skipped.homeSetupAt instanceof Date, 'a skip is remembered, so it is not asked again');

  profile = null;
  const other = await upsertProfileService(1, { heightCm: 170 });
  assert.equal(other.homeSetupAt, undefined, 'unrelated saves never mark it answered');
});
