import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FITNESS_GOAL_TO_ROUTINE_GOALS,
  ROUTINE_GOALS,
  goalDescription,
  normaliseTemplateGoal,
  orderTemplatesByGoal,
  primaryRoutineGoal,
  routineGoalsFor,
} from '../utils/workoutGoals.js';
import { GOAL_PHRASES } from '../services/assistant/contextService.js';

test('every onboarding goal code maps to real routine goals', () => {
  assert.deepEqual(
    Object.keys(FITNESS_GOAL_TO_ROUTINE_GOALS).sort(),
    Object.keys(GOAL_PHRASES).sort(),
  );
  for (const list of Object.values(FITNESS_GOAL_TO_ROUTINE_GOALS)) {
    assert.ok(list.length > 0);
    for (const g of list) assert.ok(ROUTINE_GOALS.includes(g), g);
  }
});

test('routineGoalsFor is ordered, de-duplicated and ignores unknowns', () => {
  assert.deepEqual(routineGoalsFor(['muscle_gain', 'sports_training', 'nope']), [
    'muscleBuilding',
    'strength',
    'stamina',
  ]);
  assert.deepEqual(routineGoalsFor(undefined), []);
  assert.equal(primaryRoutineGoal([]), null);
  assert.equal(primaryRoutineGoal(['weight_loss']), 'fatLoss');
});

test('a model-supplied goal is kept only if real, else the user primary goal', () => {
  assert.equal(normaliseTemplateGoal('stamina', ['weight_loss']), 'stamina');
  assert.equal(normaliseTemplateGoal('bulk', ['weight_loss']), 'fatLoss');
  assert.equal(normaliseTemplateGoal(undefined, ['flexibility_yoga']), 'mobility');
  assert.equal(normaliseTemplateGoal('bulk', []), null);
});

test('orderTemplatesByGoal puts matched goals first and is stable', () => {
  const ts = [
    { name: 'a', goal: 'mobility' },
    { name: 'b', goal: 'fatLoss' },
    { name: 'c', goal: 'mobility' },
    { name: 'd', goal: 'strength' },
  ];
  const out = orderTemplatesByGoal(ts, ['muscle_gain', 'weight_loss']);
  assert.deepEqual(out.map((t) => t.name), ['d', 'b', 'a', 'c']);
  assert.deepEqual(orderTemplatesByGoal(ts, []).map((t) => t.name), ['a', 'b', 'c', 'd']);
});

test('goalDescription is null for no goal', () => {
  assert.equal(goalDescription(null), null);
  assert.match(goalDescription('fatLoss'), /fat loss/);
});
