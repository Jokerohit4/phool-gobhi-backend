import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankExercises } from '../services/exerciseSearch.js';
import { MUSCLE_GROUPS, EQUIPMENT, LOGGING_TYPES } from '../constants/healthEnums.js';

const exercises = JSON.parse(readFileSync(new URL('../prisma/exerciseCatalogue.json', import.meta.url), 'utf8'));

test('catalogue covers every muscle group and equipment type with unique names', () => {
  assert.ok(exercises.length >= 300);
  assert.equal(new Set(exercises.map((e) => e.name.toLowerCase())).size, exercises.length);
  for (const group of MUSCLE_GROUPS) assert.ok(exercises.filter((e) => e.muscleGroup === group).length >= 10, group);
  for (const equipment of EQUIPMENT) assert.ok(exercises.some((e) => e.equipment === equipment), equipment);
  for (const e of exercises) {
    assert.ok(MUSCLE_GROUPS.includes(e.muscleGroup), e.name);
    assert.ok(EQUIPMENT.includes(e.equipment), e.name);
    assert.ok(LOGGING_TYPES.includes(e.loggingType), e.name);
    assert.ok(e.primaryMuscles.length > 0, e.name);
  }
});

for (const [query, expected] of [
  ['bench press', 'Barbell Bench Press'], ['db bench', 'Dumbbell Bench Press'],
  ['RDL', 'Romanian Deadlift'], ['pushups', 'Push-up'], ['pull ups', 'Pull-up'],
  ['skipping', 'Jump Rope'], ['dumbell bench', 'Dumbbell Bench Press'],
  ['bench dumbbell', 'Dumbbell Bench Press'], ['lat pull down', 'Lat Pulldown'],
  ['hamstring curl', 'Lying Leg Curl'],
]) {
  test(`search finds ${expected} for ${query}`, () => {
    assert.ok(rankExercises(exercises, query).some((e) => e.name === expected));
  });
}

test('a precise routine name is always the first match', () => {
  for (const e of exercises) assert.equal(rankExercises(exercises, e.name)[0]?.name, e.name);
});

test('nonsense has no fabricated matches and ranking cannot add unauthorized rows', () => {
  assert.deepEqual(rankExercises(exercises, 'zzzxxyy'), []);
  const scoped = exercises.filter((e) => e.muscleGroup === 'legs' && e.equipment === 'dumbbell');
  assert.ok(rankExercises(scoped, 'squat').every((e) => scoped.includes(e)));
});
