// The plan generator (one-plan UB1): the suggested rows rebuildPlan writes.
//
// Two properties matter most and neither is obvious from reading the code:
//
//   1. THE MEDICAL LINE. generatePlan cannot emit origin 'doctor', and no code
//      path can produce a 'medicine' or 'health' row at all. Suggested rows
//      come only from movement, water, steps, sleep and the user's own
//      supplement schedules. That is the difference between a wellness tracker
//      and a regulated device.
//   2. THE SIZE CAP. A plan with too many items turns every day red; the
//      generator targets ≤8 and, when it must trim, protects water above all.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generatePlan } from '../services/ledger/planGenerator.js';
import { JOURNEY, DEFAULT_STEPS, DEFAULT_SLEEP_MIN } from '../services/journey/journeyConfig.js';

const TARGETS = { kcal: 2500, proteinG: 133, waterMl: 3000, micros: { iron: 19 } };

const SLOTS = (weekdays) =>
  weekdays.map((weekday, i) => ({
    weekday,
    templateId: 10 + i,
    title: `Session ${i + 1}`,
    level: 'beginner',
  }));

const byLayer = (out, key) => out.items.filter((i) => i.layerKey === key);

// ---- the medical line -------------------------------------------------------

test('the generator only ever produces suggested rows, never a doctor row', () => {
  const out = generatePlan({
    onLayerKeys: ['workout', 'water', 'food', 'steps', 'sleep', 'supplements', 'health', 'medicine'],
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6]),
    targets: TARGETS,
    stepsPerDay: 8000,
    sleepMinutes: 450,
    supplements: [{ id: 1, name: 'Vitamin D' }],
  });
  assert.ok(out.items.length > 0);
  for (const item of out.items) {
    assert.equal(item.origin, 'suggested', 'the generator wrote a non-suggested row');
  }
});

test('no layer key produces a medicine or health row, whatever is passed', () => {
  // 'medicine' and 'health' are real on-layer keys, but the generator has no
  // branch for them. If this ever changes, we have started prescribing.
  const out = generatePlan({
    onLayerKeys: ['medicine', 'health', 'supplements'],
    workoutSlots: SLOTS([0]),
    targets: TARGETS,
    supplements: [{ id: 1, name: 'Creatine' }],
  });
  assert.equal(byLayer(out, 'medicine').length, 0);
  assert.equal(byLayer(out, 'health').length, 0);
  for (const item of out.items) {
    assert.notEqual(item.layerKey, 'medicine');
    assert.notEqual(item.layerKey, 'health');
  }
});

// ---- layer gating -----------------------------------------------------------

test('no on-layer keys means no items at all', () => {
  const out = generatePlan({ onLayerKeys: [], workoutSlots: SLOTS([0, 2, 4]), targets: TARGETS });
  assert.deepEqual(out.items, []);
  assert.equal(out.trimmedFrom, null);
});

test('items are created only for the on-layer keys, each carrying its layerKey', () => {
  const l1 = generatePlan({
    onLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 2, 4]),
    targets: TARGETS,
  });
  assert.deepEqual([...new Set(l1.items.map((i) => i.layerKey))].sort(), ['water', 'workout']);
  assert.equal(l1.items.some((i) => i.layerKey === 'steps'), false);
  assert.equal(l1.items.some((i) => i.layerKey === 'sleep'), false);
});

test('food never produces a stored row, even when the food layer is on', () => {
  // Food is synthesised at resolveDay time from targets and logs. There is no
  // food PlanItem — editing a target retargets tomorrow without a rebuild.
  const out = generatePlan({
    onLayerKeys: ['workout', 'water', 'food', 'steps', 'sleep'],
    workoutSlots: SLOTS([0, 3]),
    targets: TARGETS,
    stepsPerDay: 8000,
  });
  assert.equal(out.items.some((i) => i.layerKey === 'food'), false);
  assert.equal(out.items.some((i) => i.kind === 'nutrition'), false);
});

// ---- movement ---------------------------------------------------------------

test('one workout row per slot, from the stored slots', () => {
  const out = generatePlan({
    onLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 2, 4]), // Mon, Wed, Fri
    targets: TARGETS,
  });
  const workouts = byLayer(out, 'workout').filter((i) => i.kind === 'workout');
  assert.equal(workouts.length, 3, 'one item per slot');
  // Slot weekdays are 0 = Monday; item schedules are 1 = Monday.
  assert.deepEqual(workouts.map((w) => w.schedule), ['1', '3', '5']);
  assert.deepEqual(workouts.map((w) => w.title), ['Session 1', 'Session 2', 'Session 3']);
});

test('a slot with no title still gets a row, and a bad weekday is skipped', () => {
  const out = generatePlan({
    onLayerKeys: ['workout'],
    workoutSlots: [
      { weekday: 0 },
      { weekday: 7 },
      { weekday: -1 },
      { weekday: 'x' },
      { weekday: 2, title: 'Push' },
    ],
  });
  const workouts = out.items.filter((i) => i.kind === 'workout');
  assert.deepEqual(workouts.map((w) => w.title), ['Workout', 'Push']);
  assert.deepEqual(workouts.map((w) => w.schedule), ['1', '3']);
});

test('the rest row covers every weekday no slot uses, and is layered under workout', () => {
  const out = generatePlan({
    onLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 2, 4]), // uses Mon/Wed/Fri -> free Tue/Thu/Sat/Sun
    targets: TARGETS,
  });
  const rest = out.items.find((i) => i.kind === 'rest');
  assert.ok(rest, 'no rest row');
  assert.equal(rest.schedule, '2,4,6,7');
  assert.equal(rest.layerKey, 'workout', 'rest must sit under workout so it turns off with it');
  assert.equal(rest.title, 'Rest day');
});

test('an empty workout week gets a daily rest row; a full week gets none', () => {
  const none = generatePlan({ onLayerKeys: ['workout'], workoutSlots: [] });
  const rest = none.items.find((i) => i.kind === 'rest');
  assert.ok(rest, 'an empty week should still rest every day');
  assert.equal(rest.schedule, 'daily');

  const seven = generatePlan({
    onLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6]),
    targets: TARGETS,
  });
  assert.equal(seven.items.some((i) => i.kind === 'rest'), false, 'a seven-slot week has no rest day');
});

// ---- water, steps, sleep ----------------------------------------------------

test('water falls back to the journey default until a target exists', () => {
  const noTarget = generatePlan({ onLayerKeys: ['water'] });
  const water = noTarget.items.find((i) => i.layerKey === 'water');
  assert.match(water.title, /2\.5 L water/); // JOURNEY.defaultWaterMl = 2500
  assert.equal(water.targetValue, JOURNEY.defaultWaterMl);

  const withTarget = generatePlan({ onLayerKeys: ['water'], targets: TARGETS }); // waterMl 3000
  const water2 = withTarget.items.find((i) => i.layerKey === 'water');
  assert.match(water2.title, /3\.0 L water/);
  assert.equal(water2.targetValue, 3000);
});

test('steps and sleep arrive with their layer and respect the saved values', () => {
  const out = generatePlan({
    onLayerKeys: ['steps', 'sleep'],
    stepsPerDay: 7500,
    sleepMinutes: 450,
  });
  const steps = out.items.find((i) => i.layerKey === 'steps');
  assert.match(steps.title, /7,500 steps/);
  assert.equal(steps.targetValue, 7500);
  const sleep = out.items.find((i) => i.layerKey === 'sleep');
  assert.equal(sleep.title, 'Sleep 7.5 h');
  assert.equal(sleep.targetValue, 450);
  assert.equal(sleep.schedule, 'daily');
});

test('steps and sleep fall back to the contract defaults', () => {
  const out = generatePlan({ onLayerKeys: ['steps', 'sleep'] });
  const steps = out.items.find((i) => i.layerKey === 'steps');
  assert.equal(steps.targetValue, DEFAULT_STEPS);
  assert.match(steps.title, /6,000 steps/);
  const sleep = out.items.find((i) => i.layerKey === 'sleep');
  assert.equal(sleep.targetValue, DEFAULT_SLEEP_MIN);
  assert.equal(sleep.title, 'Sleep 7 h');
});

// ---- supplements ------------------------------------------------------------

test('each active supplement schedule becomes one row keyed by sourceRef', () => {
  const out = generatePlan({
    onLayerKeys: ['supplements'],
    supplements: [
      { id: 11, name: 'Vitamin D' },
      { id: 12, name: 'Omega 3' },
    ],
  });
  const supp = byLayer(out, 'supplements');
  assert.equal(supp.length, 2);
  assert.deepEqual(supp.map((s) => s.sourceRef), ['supplement:11', 'supplement:12']);
  assert.deepEqual(supp.map((s) => s.title), ['Vitamin D', 'Omega 3']);
  // Supplements are the user's own schedules, so they are habit rows, not a
  // dose we invented.
  for (const s of supp) assert.equal(s.kind, 'habit');
});

test('the generator stays silent on supplements when the caller passes null', () => {
  const out = generatePlan({ onLayerKeys: ['supplements'], supplements: null });
  assert.equal(byLayer(out, 'supplements').length, 0);
});

// ---- the size cap -----------------------------------------------------------

test('the cap trims to 8 and protects water above every other layer', () => {
  // 5 slots + rest + water + steps + sleep + 3 supplements = 12 against a cap
  // of 8. Highest rank trims first, so supplements then steps go before sleep,
  // then workout, and water (rank 0) is never touched.
  const out = generatePlan({
    onLayerKeys: ['workout', 'water', 'steps', 'sleep', 'supplements'],
    workoutSlots: SLOTS([0, 1, 2, 3, 4]),
    stepsPerDay: 8000,
    supplements: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }],
  });
  assert.equal(out.items.length, 8, `${out.items.length} items exceeded the cap`);
  assert.equal(out.trimmedFrom, 12);
  assert.ok(out.items.some((i) => i.layerKey === 'water'), 'the cap took water');
  assert.equal(out.items.some((i) => i.layerKey === 'supplements'), false, 'supplements should trim first');
  assert.equal(out.items.some((i) => i.layerKey === 'steps'), false, 'steps should trim next');
});

test('the cap keeps week order and drops the last workout slot first', () => {
  // 8 workouts + water = 9 against a cap of 8: the EIGHTH slot goes, not the
  // first, and the survivors keep their order.
  const out = generatePlan({
    onLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6, 0]), // 8 slots
    targets: TARGETS,
  });
  const workouts = out.items.filter((i) => i.kind === 'workout');
  assert.equal(workouts.length, 7);
  assert.deepEqual(workouts.map((w) => w.title), [
    'Session 1', 'Session 2', 'Session 3', 'Session 4', 'Session 5', 'Session 6', 'Session 7',
  ]);
  assert.equal(out.trimmedFrom, 9);
  assert.ok(out.items.some((i) => i.layerKey === 'water'));
});

test('a plan at or under the cap reports no trimming', () => {
  const out = generatePlan({ onLayerKeys: ['workout', 'water'], workoutSlots: SLOTS([0, 2, 4]), targets: TARGETS });
  assert.equal(out.trimmedFrom, null);
});
