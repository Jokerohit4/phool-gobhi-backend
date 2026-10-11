// The coach-journey generator (B7): layer-aware item creation.
//
// Five properties matter and none are obvious from reading the code:
//
//   1. Items exist only for unlocked layers - a locked layer's habits must
//      not appear, because they would be misses the user is being punished
//      for on a surface they cannot even see yet.
//   2. Every generated item carries its layerKey, because B10's score engine
//      skips miss lines by that key. An item with the wrong key is scored
//      under the wrong layer's rules.
//   3. Workout items come from the STORED SLOTS, not the measured activity -
//      the slot is the promise the Plan tab shows.
//   4. The size cap trims by HIGHEST layer first, so water (layer 1) is the
//      one item a crowded plan can never lose.
//   5. The doctor boundary still holds on this path: no 'medicine', no
//      'health', no supplement, ever.
//
// The flag-off path (no unlockedLayerKeys) is pinned by the pre-existing
// planGenerator.test.js, which passes unchanged - that suite IS the
// byte-for-byte assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generatePlan, LAYER_OF_LAYER_KEY, layerKeysUpTo } from '../services/ledger/planGenerator.js';

const TARGETS = {
  kcal: 2500,
  proteinG: 133,
  waterMl: 2950,
  micros: { iron: 19 },
};

const ALL_KEYS = ['workout', 'water', 'food', 'steps', 'sleep', 'supplements', 'health'];
const L3_KEYS = ['workout', 'water', 'food', 'steps', 'sleep'];

const SLOTS = (weekdays) => weekdays.map((weekday, i) => ({
  weekday,
  templateId: 10 + i,
  title: `Session ${i + 1}`,
  level: 'beginner',
}));

// ---- the layer map (copied from B9's journeyConfig, pinned here) ------------

test('the copied layer map matches the Contracts', () => {
  assert.deepEqual(LAYER_OF_LAYER_KEY, {
    workout: 1,
    water: 1,
    food: 2,
    steps: 3,
    sleep: 3,
    supplements: 4,
    health: 5,
  });
  // The journey's starting positions: a first-timer gets layer 1 only, an
  // on-off user starts with food too, a regular starts with everything.
  assert.deepEqual(layerKeysUpTo(1), ['workout', 'water']);
  assert.deepEqual(layerKeysUpTo(2), ['workout', 'water', 'food']);
  assert.deepEqual(layerKeysUpTo(5), ALL_KEYS.filter((k) => k !== 'medicine'));
});

// ---- layer-aware creation ---------------------------------------------------

test('items are created only for the unlocked layers, and each carries its layerKey', () => {
  // Layer 1 only: workouts and water. No food, no steps, no sleep.
  const l1 = generatePlan({
    unlockedLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 2, 4]),
    targets: TARGETS,
  });
  const keys1 = l1.items.map((i) => i.layerKey).filter(Boolean);
  assert.deepEqual([...new Set(keys1)].sort(), ['water', 'workout']);
  assert.equal(l1.items.some((i) => i.layerKey === 'food'), false);
  assert.equal(l1.items.some((i) => i.layerKey === 'steps'), false);
  assert.equal(l1.items.some((i) => i.layerKey === 'sleep'), false);

  // Everything unlocked: food, steps and sleep appear too, with their keys.
  // Two slots, so the plan sits exactly at the 8-item cap and nothing the
  // test is looking for has been trimmed away yet.
  const all = generatePlan({
    unlockedLayerKeys: L3_KEYS,
    workoutSlots: SLOTS([0, 3]),
    targets: TARGETS,
    stepsPerDay: 8000,
  });
  assert.equal(all.items.length, 8);
  for (const key of ['workout', 'water', 'food', 'steps', 'sleep']) {
    assert.ok(
      all.items.some((i) => i.layerKey === key),
      `${key} item missing from an all-layers plan`,
    );
  }
  // Every non-rest item is labelled; rest belongs to no layer.
  for (const item of all.items) {
    if (item.kind === 'rest') {
      assert.equal(item.layerKey, undefined, 'rest days belong to no layer');
    } else {
      assert.ok(item.layerKey, `item "${item.title}" has no layerKey`);
    }
  }
});

test('workout items come from the stored slots, not the measured activity', () => {
  const out = generatePlan({
    unlockedLayerKeys: L3_KEYS,
    workoutSlots: SLOTS([0, 2, 4]), // Mon, Wed, Fri
    targets: TARGETS,
    measuredActivity: 'very_active', // must be ignored on this path
    stepsPerDay: 6000,
  });

  const workouts = out.items.filter((i) => i.layerKey === 'workout');
  assert.equal(workouts.length, 3, 'one item per slot');
  // Slot weekdays are 0 = Monday; item schedules are 1 = Monday.
  assert.deepEqual(workouts.map((w) => w.schedule), ['1', '3', '5']);
  assert.deepEqual(workouts.map((w) => w.title), ['Session 1', 'Session 2', 'Session 3']);
  assert.ok(workouts.every((w) => w.origin === 'suggested'));
});

test('the rest day lands on a weekday no slot covers', () => {
  // Slots on Mon, Wed, Fri: rest must not collide with any of them.
  const out = generatePlan({
    unlockedLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 2, 4]),
    targets: TARGETS,
  });
  const rest = out.items.find((i) => i.kind === 'rest');
  assert.ok(rest, 'no rest item');
  const workoutDays = new Set(
    out.items.filter((i) => i.layerKey === 'workout').map((i) => Number(i.schedule)),
  );
  assert.equal(workoutDays.has(Number(rest.schedule)), false, 'rest day collides with a workout');

  // A seven-session week has no free day, so it gets no rest item rather
  // than an invented colliding one.
  const seven = generatePlan({
    unlockedLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6]),
    targets: TARGETS,
  });
  assert.equal(seven.items.some((i) => i.kind === 'rest'), false);
});

test('food items need a nutrition target, not just an unlocked layer', () => {
  // Food unlocked but no target: the "Set up food" state. The Contracts say
  // "No food items, no food misses" - so no food items, iron nudge included.
  const out = generatePlan({
    unlockedLayerKeys: [...L3_KEYS, 'food'],
    workoutSlots: SLOTS([0, 2, 4]),
    targets: null,
    diet: 'veg',
  });
  assert.equal(out.items.some((i) => i.layerKey === 'food'), false);

  // With a target, both food items appear and respect the diet vocabulary.
  const withTarget = generatePlan({
    unlockedLayerKeys: [...L3_KEYS],
    workoutSlots: SLOTS([0, 2, 4]),
    targets: TARGETS,
    diet: 'veg',
  });
  const iron = withTarget.items.find((i) => /iron/i.test(i.title));
  assert.ok(iron, 'no iron item with a target');
  assert.doesNotMatch(iron.title, /chicken|eggs/i, 'veg diet named eggs or chicken');
});

test('water falls back to the journey default until a target exists', () => {
  const noTarget = generatePlan({
    unlockedLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0]),
    targets: null,
  });
  const water = noTarget.items.find((i) => i.layerKey === 'water');
  assert.match(water.title, /2\.5 L/); // JOURNEY.defaultWaterMl, the Contracts' 2500

  const withTarget = generatePlan({
    unlockedLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0]),
    targets: TARGETS, // waterMl 2950
  });
  assert.match(withTarget.items.find((i) => i.layerKey === 'water').title, /3\.0 L/);
});

test('steps and sleep arrive with layer 3 and respect the saved step target', () => {
  // Two slots, so the layer-3 items are inside the cap and present to check.
  const out = generatePlan({
    unlockedLayerKeys: L3_KEYS,
    workoutSlots: SLOTS([0, 3]),
    targets: TARGETS,
    stepsPerDay: 7500,
  });
  const steps = out.items.find((i) => i.layerKey === 'steps');
  assert.match(steps.title, /7,500/);
  const sleep = out.items.find((i) => i.layerKey === 'sleep');
  assert.equal(sleep.schedule, 'daily');
});

// ---- the medical line --------------------------------------------------------

test('the journey generator still cannot emit a doctor, supplement or medicine item', () => {
  const out = generatePlan({
    unlockedLayerKeys: ALL_KEYS, // supplements "unlocked" too
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6]),
    targets: TARGETS,
    hasDoctorItems: true,
    goals: ['doctor_plan'],
  });
  for (const item of out.items) {
    assert.notEqual(item.origin, 'doctor', 'the medical line has been breached');
    assert.notEqual(item.layerKey, 'supplements', 'the generator suggested a supplement');
    assert.notEqual(item.layerKey, 'medicine');
    assert.notEqual(item.layerKey, 'health');
    assert.doesNotMatch(item.title, /creatine|whey|tablet|dose|prescrib/i);
  }
  // "I have a doctor's plan" is reported, not reproduced.
  assert.equal(out.hasDoctorItems, true);
});

// ---- the size cap -----------------------------------------------------------

test('the cap trims by highest layer first, and water always survives', () => {
  // Six sessions and every layer: 6 workouts + water + rest + protein + iron
  // + steps + sleep = 12 items against a cap of 8. The trim must take the
  // high layers (steps, sleep, food) before it ever touches water.
  const out = generatePlan({
    unlockedLayerKeys: L3_KEYS,
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5]),
    targets: TARGETS,
    stepsPerDay: 8000,
  });

  assert.ok(out.items.length <= 8, `${out.items.length} items exceeded the cap`);
  assert.equal(out.trimmedFrom, 12);

  const water = out.items.find((i) => i.layerKey === 'water');
  assert.ok(water, 'the cap took water: the one item it must never take');

  // What went was the high layers, in order: steps and sleep before food.
  const layersLeft = new Set(out.items.map((i) => i.layerKey));
  if (out.items.length === 8) {
    assert.equal(layersLeft.has('steps') && layersLeft.has('sleep') && layersLeft.has('food'), false,
      'the cap trimmed low-layer items while high-layer ones survived');
  }

  // And the cruelest case: a seven-session week. Water still survives.
  const seven = generatePlan({
    unlockedLayerKeys: L3_KEYS,
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6]),
    targets: TARGETS,
    stepsPerDay: 8000,
  });
  assert.ok(seven.items.some((i) => i.layerKey === 'water'), 'water lost to seven workout slots');
  assert.ok(seven.items.length <= 8);
});

test('the cap keeps order stable and trims the last slot first within a layer', () => {
  const out = generatePlan({
    unlockedLayerKeys: ['workout', 'water'],
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6, 0]), // 8 slots: one past the cap
    targets: TARGETS,
  });
  // 8 workouts + water = 9 against a cap of 8: the EIGHTH slot goes, not the
  // first, and the survivors keep their week order.
  const workouts = out.items.filter((i) => i.layerKey === 'workout');
  assert.equal(workouts.length, 7);
  assert.deepEqual(workouts.map((w) => w.title), ['Session 1', 'Session 2', 'Session 3', 'Session 4', 'Session 5', 'Session 6', 'Session 7']);
});

// ---- the flag-off path ------------------------------------------------------

test('without unlockedLayerKeys the legacy generator runs unchanged', () => {
  const legacy = generatePlan({ goals: ['recomp'], targets: TARGETS, measuredActivity: 'moderate' });

  // The shape the old suite pins: one workout item built from the measured
  // activity, four scheduled days, and no layerKey anywhere.
  const workout = legacy.items.find((i) => i.kind === 'workout');
  assert.equal(workout.schedule.split(',').length, 4);
  assert.equal(legacy.items.every((i) => i.layerKey === undefined), true);
  assert.equal(legacy.items.some((i) => i.kind === 'rest'), true);
});
