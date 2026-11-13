// Double progression: the rules that decide when a routine asks for more.
// Pure functions, no database. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProgression, progressionFields, WEIGHT_STEP_KG } from '../services/progressionService.js';

const te = (over = {}) => ({
  targetSets: 3,
  targetReps: 8,
  repMin: 8,
  repMax: 12,
  targetWeightKg: 60,
  targetDurationSeconds: null,
  ...over,
});
const sets = (...pairs) => pairs.map(([weightKg, reps]) => ({ completed: true, weightKg, reps }));

test('no rep range, no progression (legacy routines are untouched)', () => {
  assert.equal(computeProgression(te({ repMax: null, repMin: null }), sets([60, 12], [60, 12], [60, 12])), null);
});

test('duration exercises never progress', () => {
  assert.equal(computeProgression(te({ targetDurationSeconds: 60 }), sets([0, 12], [0, 12], [0, 12])), null);
});

test('every set at repMax adds one step of weight and resets the rep goal', () => {
  const r = computeProgression(te({ targetReps: 12 }), sets([60, 12], [60, 12], [60, 12]));
  assert.deepEqual(r, { kind: 'weight', weightKg: 60 + WEIGHT_STEP_KG, targetReps: 8 });
});

test('hitting the rep goal on every set raises the goal by one rep, same weight', () => {
  const r = computeProgression(te(), sets([60, 8], [60, 9], [60, 8]));
  assert.deepEqual(r, { kind: 'reps', weightKg: 60, targetReps: 9 });
});

test('missing the goal on one set changes nothing', () => {
  assert.equal(computeProgression(te(), sets([60, 8], [60, 7], [60, 8])), null);
});

test('fewer completed sets than planned changes nothing', () => {
  assert.equal(computeProgression(te(), sets([60, 12], [60, 12])), null);
});

test('lighter sets do not count and never lower the stored weight', () => {
  // Two at weight, one deload set: only two count, so no full set.
  assert.equal(computeProgression(te(), sets([60, 12], [60, 12], [50, 12])), null);
});

test('unchecked sets are ignored', () => {
  const s = [
    { completed: true, weightKg: 60, reps: 12 },
    { completed: true, weightKg: 60, reps: 12 },
    { completed: false, weightKg: 60, reps: 12 },
  ];
  assert.equal(computeProgression(te({ targetReps: 12 }), s), null);
});

test('no stored weight yet: the first finished workout sets the baseline', () => {
  const r = computeProgression(te({ targetWeightKg: null }), sets([55, 6], [55, 6], [52.5, 5]));
  assert.deepEqual(r, { kind: 'baseline', weightKg: 55, targetReps: 8 });
});

test('bodyweight climbs in reps but has no weight to add at the top', () => {
  const bw = te({ targetWeightKg: null });
  assert.deepEqual(computeProgression(bw, sets([0, 8], [0, 8], [0, 8])), {
    kind: 'reps',
    weightKg: null,
    targetReps: 9,
  });
  assert.equal(computeProgression(te({ targetWeightKg: null, targetReps: 12 }), sets([0, 12], [0, 12], [0, 12])), null);
});

test('a weight bump never leaves the rep goal below the range', () => {
  const r = computeProgression(te({ targetReps: 11 }), sets([60, 12], [60, 12], [60, 12]));
  assert.equal(r.targetReps, 8);
});

test('progressionFields: range must come as a pair and be ordered', () => {
  assert.throws(() => progressionFields({ repMin: 8 }), { status: 400 });
  assert.throws(() => progressionFields({ repMin: 12, repMax: 8 }), { status: 400 });
  assert.throws(() => progressionFields({ repMin: 0, repMax: 8 }), { status: 400 });
});

test('progressionFields: the rep goal is pulled inside the range', () => {
  assert.equal(progressionFields({ repMin: 8, repMax: 12 }).targetReps, 8);
  assert.equal(progressionFields({ repMin: 8, repMax: 12, targetReps: 20 }).targetReps, 8);
  assert.equal(progressionFields({ repMin: 8, repMax: 12, targetReps: 10 }).targetReps, 10);
});

test('progressionFields: legacy payloads pass through untouched', () => {
  assert.deepEqual(progressionFields({ targetReps: 10 }), {
    repMin: null,
    repMax: null,
    targetWeightKg: null,
    targetReps: 10,
  });
});

test('progressionFields: a nonsense weight is rejected', () => {
  assert.throws(() => progressionFields({ targetWeightKg: -5 }), { status: 400 });
  assert.throws(() => progressionFields({ targetWeightKg: '60' }), { status: 400 });
});
