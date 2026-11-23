import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// first_workout_started / first_food_logged / first_water_logged are activation
// milestones. The failure modes worth pinning: firing for a user who already has
// rows, firing before/without a successful write, leaking food content into the
// properties, and an analytics fault breaking the user's own action.

let trackCalls = [];
let probes;

before(async () => {
  const { mock } = await import('node:test');
  const href = (p) => new URL(p, import.meta.url).href;
  mock.module(href('../utils/analytics.js'), {
    exports: { track: (...args) => trackCalls.push(args) },
  });
  probes = await import('../services/activationEvents.js');
});

beforeEach(() => {
  trackCalls = [];
});

const prismaWith = ({ food = null, water = null, workout = null } = {}) => {
  const seen = {};
  return {
    seen,
    foodLog: { findFirst: async (a) => ((seen.food = a), food) },
    waterLog: { findFirst: async (a) => ((seen.water = a), water) },
    workoutSession: { findFirst: async (a) => ((seen.workout = a), workout) },
  };
};

test('first_food_logged fires once, with counts and enums only', async () => {
  const probe = await probes.firstFoodLogProbe(prismaWith(), 7);
  probe.emit({ loggedCount: 3, source: 'saved_meal' });
  assert.equal(trackCalls.length, 1);
  const [event, userId, props] = trackCalls[0];
  assert.equal(event, 'first_food_logged');
  assert.equal(userId, 7);
  assert.deepEqual(props, { source: 'saved_meal', logged_count: 3 });
});

test('first_food_logged does not fire for a user who already has a food log', async () => {
  const probe = await probes.firstFoodLogProbe(prismaWith({ food: { id: 1 } }), 7);
  probe.emit({ loggedCount: 1, source: 'search' });
  assert.equal(trackCalls.length, 0);
});

test('first_food_logged stays silent when a request wrote zero rows', async () => {
  const probe = await probes.firstFoodLogProbe(prismaWith(), 7);
  probe.emit({ loggedCount: 0, source: 'saved_meal' });
  assert.equal(trackCalls.length, 0);
});

test('nothing is emitted until emit() is called (a failed write never reports activation)', async () => {
  await probes.firstFoodLogProbe(prismaWith(), 7);
  await probes.firstWaterLogProbe(prismaWith(), 7);
  await probes.firstWorkoutProbe(prismaWith(), 7);
  assert.equal(trackCalls.length, 0);
});

test('first_water_logged fires once with the amount only', async () => {
  const prisma = prismaWith();
  const probe = await probes.firstWaterLogProbe(prisma, 9);
  probe.emit({ ml: 250 });
  assert.deepEqual(trackCalls, [['first_water_logged', 9, { ml: 250 }]]);
  assert.deepEqual(prisma.seen.water.where, { userId: 9 });
});

test('first_water_logged is skipped when the user already logged water', async () => {
  const probe = await probes.firstWaterLogProbe(prismaWith({ water: { id: 4 } }), 9);
  probe.emit({ ml: 250 });
  assert.equal(trackCalls.length, 0);
});

test('first_workout_started reports template vs custom and ignores attendance drafts', async () => {
  const prisma = prismaWith();
  const fromTemplate = await probes.firstWorkoutProbe(prisma, 5);
  fromTemplate.emit({ templateId: 12 });
  const custom = await probes.firstWorkoutProbe(prismaWith(), 5);
  custom.emit({ templateId: null });
  assert.deepEqual(trackCalls.map((c) => c[2]), [{ workout_source: 'template' }, { workout_source: 'custom' }]);
  // Attendance-draft sessions (attendedAt set by the internal route) are not a started workout.
  assert.deepEqual(prisma.seen.workout.where, { userId: 5, attendedAt: null });
});

test('first_workout_started is skipped when a user-started session exists', async () => {
  const probe = await probes.firstWorkoutProbe(prismaWith({ workout: { id: 2 } }), 5);
  probe.emit({ templateId: null });
  assert.equal(trackCalls.length, 0);
});

test('an analytics or database fault never breaks the user action', async () => {
  const broken = { foodLog: { findFirst: async () => { throw new Error('db down'); } } };
  const probe = await probes.firstFoodLogProbe(broken, 1);
  assert.doesNotThrow(() => probe.emit({ loggedCount: 1, source: 'search' }));
  assert.equal(trackCalls.length, 0);
});

test('the three events are wired where the rows are persisted', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const workout = read('../services/workoutSessionService.js');
  assert.match(workout, /firstWorkoutProbe\(prisma, userId\)[\s\S]*firstWorkout\.emit\(\{ templateId \}\)/);
  const habits = read('../controllers/habitsController.js');
  assert.match(habits, /firstWaterLogProbe\(prisma, req\.userId\)[\s\S]*firstWater\.emit/);
  const ledger = read('../controllers/ledgerController.js');
  // search, custom, repeat-day, saved-meal and photo-confirm all go through the probe
  assert.equal((ledger.match(/firstFoodLogProbe\(prisma, req\.userId\)/g) || []).length, 4);
  assert.equal((ledger.match(/firstFood\.emit\(/g) || []).length, 5);
});
