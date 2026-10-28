// Persona switching between the workout and wellbeing plans
// (journeyService.switchJourneyTrack / startWellnessJourney). Pinned: a round
// trip loses nothing — the workout unlocks, start level, slots and the user's
// own weekly goal all survive time on a wellbeing plan.
// Run with: node --experimental-test-module-mocks --test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const db = {};
let profile;
let rebuilds;

function reset() {
  db.progress = {
    userId: 1, startLevel: 'experienced', startedAt: new Date('2026-09-01T00:00:00Z'), wellnessOnly: false,
    unlocked: [{ layer: 1, via: 'start' }, { layer: 2, via: 'early' }, { layer: 4, via: 'steady_weeks' }],
    workoutSnapshot: null, wellnessFocuses: [], foodEarlyAt: null,
  };
  db.prescription = { userId: 1, stepsPerDay: 8000, workoutSlots: [{ weekday: 1, title: 'Push' }, { weekday: 4, title: 'Pull' }] };
  db.weeklyGoal = { userId: 1, sessionsPerWeek: 5, setByUser: true };
  profile = { id: 1, persona: 'wellness', wellnessFocuses: ['sleep'], wellnessDayPattern: 'mixed' };
  rebuilds = [];
}

let switchJourneyTrack;
let startJourney;

test('setup: mock dependencies once, import the journey service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.journeyProgress = {
            findUnique: async () => (db.progress ? { ...db.progress } : null),
            upsert: async ({ update }) => { Object.assign(db.progress, update); return { ...db.progress }; },
            update: async ({ data }) => { Object.assign(db.progress, data); return { ...db.progress }; },
          };
          this.prescription = {
            findUnique: async () => (db.prescription ? { ...db.prescription } : null),
            updateMany: async ({ data }) => { Object.assign(db.prescription, data); return { count: 1 }; },
          };
          this.weeklyGoal = { deleteMany: async () => { db.weeklyGoal = null; return { count: 1 }; } };
          // getJourney's existing-data unlock reads: an empty account.
          const none = { findFirst: async () => null, findUnique: async () => null };
          this.foodLog = none; this.biometricEntry = none; this.healthProfile = none; this.medicalDocument = none;
        }
      },
    },
  });
  t.mock.module(new URL('../utils/fetchUserProfile.js', import.meta.url).href, {
    exports: { fetchUserProfileInternal: async () => profile },
  });
  t.mock.module(new URL('../services/plan/rebuildPlan.js', import.meta.url).href, {
    exports: { rebuildPlan: async (_p, userId, opts) => { rebuilds.push(opts?.reason); } },
  });
  // The starter plan writes the wellbeing prescription (no workout slots).
  // File-level mock, not t.mock: journeyService imports it dynamically, after
  // this setup test (and its t.mock scope) has ended.
  mock.module(new URL('../services/ledger/starterPlanService.js', import.meta.url).href, {
    exports: {
      createStarterPlan: async (_p, _u, opts) => {
        db.prescription = { ...db.prescription, workoutSlots: opts.wellnessOnly ? [] : [{ weekday: 2, title: 'Fresh' }], stepsPerDay: opts.wellnessOnly ? 4000 : 6000 };
        return { plan: true };
      },
    },
  });
  t.mock.module(new URL('../services/journey/showedUpDays.js', import.meta.url).href, {
    exports: { getShowedUpDays: async () => [], getLastShowedUpDate: async () => null },
  });
  t.mock.module(new URL('../services/journey/referralHomeTrigger.js', import.meta.url).href, {
    exports: { checkAndTriggerHomeDaysReferral: async () => {} },
  });
  ({ switchJourneyTrack, startJourney } = await import('../services/journey/journeyService.js'));
});

test('workout -> wellness -> workout restores the workout track', async () => {
  reset();
  const before = structuredClone({ unlocked: db.progress.unlocked, startLevel: db.progress.startLevel, slots: db.prescription.workoutSlots });

  const toWellness = await switchJourneyTrack(1, 'wellness');
  assert.equal(toWellness.track, 'wellness');
  assert.equal(db.progress.wellnessOnly, true);
  assert.deepEqual(db.prescription.workoutSlots, [], 'the wellbeing plan has no workout slots');
  assert.ok(db.weeklyGoal, 'the user\'s own weekly goal is kept, not deleted');
  assert.deepEqual(db.progress.workoutSnapshot.unlocked, before.unlocked);

  profile = { ...profile, persona: 'home_training' };
  const back = await switchJourneyTrack(1, 'home_training');
  assert.equal(back.restored, true);
  assert.equal(db.progress.wellnessOnly, false);
  assert.deepEqual(db.progress.unlocked, before.unlocked);
  assert.equal(db.progress.startLevel, before.startLevel);
  assert.deepEqual(db.prescription.workoutSlots, before.slots);
  assert.equal(db.prescription.stepsPerDay, 8000);
  assert.equal(db.progress.workoutSnapshot, null);
  assert.deepEqual(db.weeklyGoal, { userId: 1, sessionsPerWeek: 5, setByUser: true });
  assert.ok(rebuilds.includes('persona_switch'));
});

test('switching between two workout personas leaves the plan alone', async () => {
  reset();
  const result = await switchJourneyTrack(1, 'own_gym');
  assert.equal(result.changed, false);
  assert.equal(db.progress.workoutSnapshot, null);
});

test('no journey yet: nothing to switch', async () => {
  reset();
  db.progress = null;
  assert.deepEqual(await switchJourneyTrack(1, 'wellness'), { changed: false, reason: 'no_journey' });
});

test('a second wellness start does not overwrite the saved workout track', async () => {
  reset();
  await switchJourneyTrack(1, 'wellness');
  const saved = structuredClone(db.progress.workoutSnapshot);
  db.progress.wellnessOnly = true;
  await switchJourneyTrack(1, 'wellness');
  assert.deepEqual(db.progress.workoutSnapshot, saved);
});

test('a switched-out wellness user can start a workout journey despite old wellness answers', async () => {
  // Before personas, workoutIntent=wellness_only made this a 409 forever.
  reset();
  profile = { id: 1, persona: 'home_training', workoutIntent: 'wellness_only', wellnessFocuses: ['sleep'] };
  db.progress.wellnessOnly = true;
  db.progress.workoutSnapshot = { unlocked: [{ layer: 3, via: 'steady_weeks' }], startLevel: 'experienced' };
  await startJourney(1, { experienceLevel: 'experienced', daysPerWeek: 3, location: 'home', goals: [] });
  assert.equal(db.progress.wellnessOnly, false);
  // Restored, then merged with the start-level layers by getJourney.
  assert.ok(db.progress.unlocked.some((u) => u.layer === 3 && u.via === 'steady_weeks'));
  assert.equal(db.progress.workoutSnapshot, null);
});

test('a current wellness persona still cannot start a workout journey', async () => {
  reset();
  await assert.rejects(startJourney(1, { experienceLevel: 'experienced', daysPerWeek: 3, location: 'home' }), { code: 'WELLNESS_JOURNEY_REQUIRED' });
});
