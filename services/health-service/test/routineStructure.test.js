import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuredExercises, routineDescription } from '../services/routineStructure.js';

const entry = (phase, extra = {}) => ({ exerciseId: 1, targetSets: 1, targetDurationSeconds: 30, phase, ...extra });

test('legacy routines default to main; phases sort stably and allow the same movement in different phases', () => {
  const rows = structuredExercises([entry('cool_down'), entry('main', { exerciseId: 2 }), entry('warm_up'), entry('main', { exerciseId: 3 }), entry(undefined)]);
  assert.deepEqual(rows.map((e) => e.phase), ['warm_up', 'main', 'main', 'main', 'cool_down']);
  assert.deepEqual(rows.map((e) => e.exerciseId), [1, 2, 3, 1, 1]);
});

test('preparation keeps zero rest and instructions, and cannot opt into progression', () => {
  const [row] = structuredExercises([entry('warm_up', { restSeconds: 0, instructions: '  Keep it easy  ', repMin: 8, repMax: 12 })]);
  assert.equal(row.restSeconds, 0);
  assert.equal(row.instructions, 'Keep it easy');
  assert.equal(row.repMin, null);
  assert.equal(row.repMax, null);
});

test('invalid edits are rejected before replacement', () => {
  for (const rows of [[], [entry('unknown')], [entry('main', { targetSets: 0 })], [entry('main', { restSeconds: -1 })], [entry('main', { targetDurationSeconds: 0 })], [entry('main', { instructions: 42 })]]) {
    assert.throws(() => structuredExercises(rows), { status: 400 });
  }
  assert.deepEqual(routineDescription({}), {});
  assert.deepEqual(routineDescription({ description: '  Slow controlled work  ' }), { description: 'Slow controlled work' });
  assert.deepEqual(routineDescription({ description: '' }), { description: null });
});
