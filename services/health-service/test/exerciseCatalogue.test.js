import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankExercises, foldPlural, normalizeExerciseQuery } from '../services/exerciseSearch.js';
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
  ['barblel bech press', 'Barbell Bench Press'],
  ['dumb bell bench press', 'Dumbbell Bench Press'],
]) {
  test(`search finds ${expected} for ${query}`, () => {
    assert.ok(rankExercises(exercises, query).some((e) => e.name === expected));
  });
  test(`search ranks ${expected} in the top 3 for ${query}`, () => {
    // Several fixtures (bench press, lat pull down, hamstring curl...) have close
    // variants; the intended exercise must still surface at the top.
    const names = rankExercises(exercises, query).slice(0, 3).map((e) => e.name);
    assert.ok(names.includes(expected), `${expected} not in ${JSON.stringify(names)}`);
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

const top = (query, n = 3) => rankExercises(exercises, query).slice(0, n).map((e) => e.name);

test('typo queries rank the intended exercise first', () => {
  assert.equal(rankExercises(exercises, 'bech press')[0].name, 'Barbell Bench Press');
  assert.equal(rankExercises(exercises, 'barblel bech press')[0].name, 'Barbell Bench Press');
  assert.equal(rankExercises(exercises, 'dumb bell bench press')[0].name, 'Dumbbell Bench Press');
});

test('spoken counts and filler words are ignored', () => {
  for (const query of ['bench press 3 sets of 10', 'bench press for 10 reps', '10 reps bench press', 'bench press 3x10']) {
    assert.ok(top(query, 3).includes('Barbell Bench Press'), query);
  }
  assert.ok(top('do 10 push ups', 10).includes('Push-up'));
  // never reduces a non-empty query to "match everything"
  assert.deepEqual(rankExercises(exercises, '10 sets'), []);
});

test('queries with no searchable characters return nothing, not the whole catalogue', () => {
  for (const query of ['!!!', 'बेंच', '   ?? ']) assert.deepEqual(rankExercises(exercises, query), [], query);
  for (const query of ['', '   ', undefined, null]) assert.equal(rankExercises(exercises, query).length, exercises.length);
});

test('four-letter words do not fuzzy-match a different word', () => {
  const squat = rankExercises(exercises, 'back squat').map((e) => e.name);
  assert.ok(squat.length > 0);
  assert.ok(!squat.slice(0, 5).some((n) => /hack squat/i.test(n)), squat.slice(0, 5).join());
  // Synthetic rows isolate the fuzzy rule from real catalogue words/muscles.
  const row = (name) => ({ name, muscleGroup: 'other', equipment: 'other', primaryMuscles: ['x'], secondaryMuscles: [] });
  for (const [query, wrong] of [['back', 'Hack'], ['neck', 'Deck'], ['bell', 'Belt'], ['pull', 'Full'], ['calf', 'Half']]) {
    assert.deepEqual(rankExercises([row(wrong)], query), [], query + ' vs ' + wrong);
  }
  // one-letter typos on 4-letter words that are transposition/deletion/insertion still match
  assert.equal(rankExercises([row('Bench')], 'bech').length, 1);
  assert.equal(rankExercises([row('Curl')], 'crul').length, 1);
});

test('plural queries match singular names', () => {
  assert.equal(foldPlural('presses'), 'press');
  assert.equal(foldPlural('crunches'), 'crunch');
  assert.equal(foldPlural('deadlifts'), 'deadlift');
  assert.equal(foldPlural('dips'), 'dip');
  assert.equal(foldPlural('press'), 'press');
  assert.equal(foldPlural('abs'), 'abs');
  assert.ok(top('bench presses', 3).includes('Barbell Bench Press'));
  assert.ok(top('crunches', 3).includes('Crunches'));
  assert.ok(top('deadlifts', 10).some((n) => /deadlift/i.test(n)));
  assert.ok(top('dips', 5).some((n) => /dip/i.test(n)));
});

test('sit-up folding respects word boundaries', () => {
  assert.equal(normalizeExerciseQuery('sit ups'), 'situp');
  assert.equal(normalizeExerciseQuery('push upper body'), 'push upper body');
  assert.equal(normalizeExerciseQuery('sit upright'), 'sit upright');
  assert.equal(normalizeExerciseQuery('pull upside'), 'pull upside');
});
