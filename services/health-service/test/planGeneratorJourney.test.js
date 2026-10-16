// The coach-journey contract that feeds the one generator (one-plan UB1).
//
// The journey config is the single source of truth for which layerKeys are on,
// and rebuildPlan turns those keys into generatePlan's `onLayerKeys`. This
// suite pins the config against the Contracts and pins the generator's
// layer-awareness to that config, so a drift in either direction fails here.
//
// The rest of the generator's behaviour (rows, cap, medical line) is pinned by
// planGenerator.test.js; this file is deliberately about the layer map and the
// start positions.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JOURNEY,
  LAYER_OF_LAYER_KEY,
  layerKeysUpTo,
  startLayerFor,
  ROW_KINDS,
  ALWAYS_ON_LAYER_KEYS,
} from '../services/journey/journeyConfig.js';
import { generatePlan } from '../services/ledger/planGenerator.js';

const ALL_LAYER_KEYS = ['workout', 'water', 'food', 'steps', 'sleep', 'supplements', 'health'];

const SLOTS = (weekdays) =>
  weekdays.map((weekday, i) => ({ weekday, templateId: 10 + i, title: `Session ${i + 1}`, level: 'beginner' }));

// ---- the layer map (the Contracts) ------------------------------------------

test('the layer map matches the Contracts', () => {
  assert.deepEqual(LAYER_OF_LAYER_KEY, {
    workout: 1,
    water: 1,
    food: 2,
    steps: 3,
    sleep: 3,
    supplements: 4,
    health: 5,
  });
  assert.deepEqual(layerKeysUpTo(1), ['workout', 'water']);
  assert.deepEqual(layerKeysUpTo(2), ['workout', 'water', 'food']);
  assert.deepEqual(layerKeysUpTo(5), ALL_LAYER_KEYS);
});

test('the starting layers match the Contracts', () => {
  assert.deepEqual(JOURNEY.startLayer, {
    new_to_gym: 1,
    restarting_after_break: 2,
    experienced: 5,
  });
  // An unknown level floors to the first-timer start, never a locked-everything
  // state.
  assert.equal(startLayerFor('alien'), 1);
});

test('own and medicine are always-on keys, never journey-locked', () => {
  assert.deepEqual(ALWAYS_ON_LAYER_KEYS, ['own', 'medicine']);
});

test('the nine wire row kinds are declared', () => {
  assert.deepEqual(ROW_KINDS, ['workout', 'rest', 'water', 'steps', 'sleep', 'supplement', 'own', 'doctor', 'food']);
});

// ---- layer-aware creation ---------------------------------------------------

test('a layer-1 user gets movement and water and nothing higher', () => {
  const out = generatePlan({
    onLayerKeys: layerKeysUpTo(1),
    workoutSlots: SLOTS([0, 2, 4]),
    targets: { waterMl: 3000 },
  });
  const keys = new Set(out.items.map((i) => i.layerKey));
  assert.ok(keys.has('workout'));
  assert.ok(keys.has('water'));
  assert.equal(keys.has('steps'), false);
  assert.equal(keys.has('sleep'), false);
  assert.equal(keys.has('supplements'), false);
});

test('opening every layer adds body and supplement rows, each with its key', () => {
  const out = generatePlan({
    onLayerKeys: layerKeysUpTo(5),
    workoutSlots: SLOTS([0, 3]), // two slots: inside the cap, nothing trimmed
    stepsPerDay: 8000,
    sleepMinutes: 450,
    supplements: [{ id: 1, name: 'Vitamin D' }],
  });
  for (const key of ['workout', 'rest', 'water', 'steps', 'sleep', 'supplements']) {
    assert.ok(out.items.some((i) => i.layerKey === key || (key === 'rest' && i.kind === 'rest')),
      `${key} missing from a fully-open plan`);
  }
  // food/health/medicine never appear as stored rows.
  assert.equal(out.items.some((i) => i.layerKey === 'food'), false);
  assert.equal(out.items.some((i) => i.layerKey === 'health'), false);
  assert.equal(out.items.some((i) => i.layerKey === 'medicine'), false);
});

test('the journey defaults arrive when no targets or prescription exist', () => {
  const out = generatePlan({ onLayerKeys: layerKeysUpTo(5), workoutSlots: [], supplements: [] });
  assert.match(out.items.find((i) => i.layerKey === 'water').title, /2\.5 L water/);
  assert.match(out.items.find((i) => i.layerKey === 'steps').title, /6,000 steps/);
  assert.equal(out.items.find((i) => i.layerKey === 'sleep').title, 'Sleep 7 h');
});

test('even a fully-open journey cannot breach the medical line', () => {
  const out = generatePlan({
    onLayerKeys: [...layerKeysUpTo(5), 'medicine', 'own'],
    workoutSlots: SLOTS([0, 1, 2, 3, 4, 5, 6]),
    stepsPerDay: 8000,
    sleepMinutes: 450,
    supplements: [{ id: 1, name: 'Omega 3' }],
  });
  for (const item of out.items) {
    assert.equal(item.origin, 'suggested');
    assert.notEqual(item.layerKey, 'medicine');
    assert.notEqual(item.layerKey, 'health');
  }
});
