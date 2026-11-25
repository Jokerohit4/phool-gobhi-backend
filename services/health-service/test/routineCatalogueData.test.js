// The routine catalogue data file (prisma/catalogue/routines.json) is content
// shipped to every user, so its rules are enforced here, before release. These
// are the checks the customer app used to run against its bundled starters
// (starter_templates_contract_test.dart and friends); they live with the data
// now. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CATEGORIES, validateCatalogueData, routineRows } from '../services/routines/catalogueSeed.js';
import { preparationExerciseNames } from '../services/routines/preparation.js';
import { locationFit } from '../services/routines/locationFit.js';
import { ROUTINE_GOALS } from '../utils/workoutGoals.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const routines = read('../prisma/catalogue/routines.json').routines;
const library = read('../prisma/exerciseCatalogue.json');
const byName = new Map(library.map((e) => [e.name.toLowerCase(), e]));
const get = (name) => routines.find((r) => r.texts.en.name === name);

// The 12 routines that shipped English-only with the home track.
const ENGLISH_ONLY = new Set([
  'home_full_body_20', 'home_full_body_15', 'home_push', 'home_pull', 'home_legs', 'home_core_10',
  'home_cardio_low_impact', 'home_mobility', 'home_push_intermediate', 'home_legs_intermediate',
  'home_full_body_intermediate', 'home_desk_reset',
]);
const ORIGINAL = (r) => r.key.startsWith('gym_starter_') || ENGLISH_ONLY.has(r.key);
const CARDIO = new Set(['Treadmill Walk', 'Brisk Walking', 'Jogging', 'Stationary Bike', 'Cycling', 'Elliptical']);
const mainOf = (r) => r.exercises.filter((e) => (e.phase ?? 'main') === 'main');

test('the file is structurally valid', () => {
  validateCatalogueData(routines);
  assert.ok(routines.length >= 50);
});

test('every goal, category and level is from the known sets', () => {
  for (const r of routines) {
    assert.ok(ROUTINE_GOALS.includes(r.goal), `${r.key} goal`);
    assert.ok(CATEGORIES.includes(r.category), `${r.key} category`);
  }
  for (const goal of ROUTINE_GOALS) {
    assert.ok(routines.filter((r) => r.goal === goal).length >= 4, `at least four ${goal} routines`);
  }
});

test('every exercise, including generated warm-up and cool-down, exists in the library with the right target type', () => {
  for (const name of preparationExerciseNames()) {
    const ex = byName.get(name.toLowerCase());
    assert.ok(ex, `preparation exercise ${name} missing from the library`);
    assert.notEqual(ex.loggingType, 'sets_reps_weight', `${name} must be timed`);
  }
  for (const r of routines) {
    for (const row of routineRows(r)) {
      const ex = byName.get(row.name.toLowerCase());
      assert.ok(ex, `${r.key}: ${row.name} missing from the library`);
      assert.ok(row.sets > 0, `${r.key}: ${row.name} sets`);
      if (ex.loggingType === 'sets_reps_weight') {
        assert.ok(row.reps > 0 && row.seconds === undefined, `${r.key}: ${row.name} is counted in reps`);
      } else {
        assert.ok(row.seconds > 0, `${r.key}: ${row.name} is timed`);
      }
    }
  }
});

test('no routine has more than six main exercises', () => {
  for (const r of routines) assert.ok(mainOf(r).length <= 6, r.key);
});

test('new lifting routines end with an easy cardio finisher that is timed and rest-free', () => {
  const lifting = routines.filter((r) => !ORIGINAL(r) && (r.goal === 'muscleBuilding' || r.goal === 'strength'));
  assert.ok(lifting.length >= 20);
  for (const r of lifting) {
    const last = mainOf(r).at(-1);
    assert.ok(CARDIO.has(last.name), `${r.key}: cardio comes last`);
    assert.ok(last.seconds >= 300 && last.rest === 0, `${r.key}: finisher is timed and rest-free`);
  }
});

test('warm-up and cool-down are generated for the category, timed and rest-free', () => {
  for (const r of routines) {
    const rows = routineRows(r);
    assert.equal(rows[0].phase, 'warm_up', r.key);
    assert.equal(rows.at(-1).phase, 'cool_down', r.key);
    const phases = rows.map((x) => x.phase);
    assert.deepEqual(phases, [...phases].sort((a, b) => ['warm_up', 'main', 'cool_down'].indexOf(a) - ['warm_up', 'main', 'cool_down'].indexOf(b)));
    for (const row of rows.filter((x) => x.phase !== 'main')) {
      assert.ok(row.seconds > 0 && row.rest === 0 && row.instructions, `${r.key}: ${row.name}`);
    }
  }
  const push = routineRows(get('Push Day B')).filter((x) => x.phase === 'warm_up').map((x) => x.name);
  const pull = routineRows(get('Pull Day B')).filter((x) => x.phase === 'warm_up').map((x) => x.name);
  assert.deepEqual(push, ['March in Place', 'Shoulder Circles', 'Thoracic Rotation']);
  assert.deepEqual(pull, ['March in Place', 'Cat-Cow', 'Arm Circles']);
});

test('a run routine keeps its own walking warm-up and cool-down', () => {
  const rows = routineRows(get('Walk-Jog Starter'));
  assert.equal(rows[0].name, 'Brisk Walking');
  assert.equal(rows.filter((r) => r.phase === 'warm_up').length, 1);
});

test('push, pull and legs each have an A and B day, beginner and gym-intermediate, plus dumbbell options', () => {
  for (const name of [
    'Push Day A', 'Push Day B', 'Pull Day A', 'Pull Day B', 'Leg Day', 'Leg Day B',
    'Push — gym intermediate', 'Pull — gym intermediate', 'Legs — gym intermediate',
    'Dumbbell Push', 'Dumbbell Pull', 'Dumbbell Lower Body',
    'Upper Body A', 'Upper Body B', 'Lower Body A', 'Lower Body B',
  ]) assert.ok(get(name), `${name} is in the catalogue`);
  assert.ok(routines.filter((r) => r.category === 'pull').length >= 6, 'several pull choices');
  assert.ok(routines.filter((r) => r.category === 'push').length >= 6, 'several push choices');
});

test('English names are unique, and every routine except the home-track originals is translated', () => {
  const names = routines.map((r) => r.texts.en.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  for (const r of routines) {
    for (const [lang, t] of Object.entries(r.texts)) {
      assert.ok(t.name && t.guidance, `${r.key}/${lang} name and guidance`);
      assert.ok(!/\d+ exercises?/.test(t.description ?? ''), `${r.key}/${lang}: the count is derived, not typed`);
    }
    if (ENGLISH_ONLY.has(r.key)) continue;
    assert.ok(r.texts.hi && r.texts.hinglish, `${r.key} needs Hindi and Hinglish`);
    assert.match(r.texts.hi.name, /[ऀ-ॿ]/, `${r.key} Hindi name is Devanagari`);
    assert.doesNotMatch(r.texts.hinglish.name + (r.texts.hinglish.description ?? ''), /[ऀ-ॿ]/, `${r.key} Hinglish is Roman script`);
  }
});

test('routines the plan engine can place in a week are in the plain template list', () => {
  for (const key of [
    'gym_pull_a', 'gym_push_b', 'gym_pull_b', 'gym_legs_b',
    'gym_push_intermediate', 'gym_pull_intermediate', 'gym_legs_intermediate',
    'gym_starter_full_body_x3', 'gym_starter_push_a', 'gym_starter_legs', 'gym_starter_upper_abs',
  ]) assert.equal(routines.find((r) => r.key === key).legacy, true, key);
});

// ---- location fit, derived from the library's equipment ----------------------

function fitOf(routine) {
  return locationFit({
    goal: routine.goal,
    exercises: routineRows(routine).map((row) => ({ phase: row.phase, exercise: byName.get(row.name.toLowerCase()) })),
  });
}

test('which routines are home routines is derived from equipment, and matches what the app used to decide by name', () => {
  const home = routines.filter((r) => fitOf(r).isHomeRoutine).map((r) => r.texts.en.name).sort();
  assert.deepEqual(home, [
    'Bodyweight Conditioning', 'At-Home Stamina', 'First Workout at Home', 'Low-Impact Conditioning', 'Quick Home Session',
    'Core — 10 minute', 'Full body — 15 minute', 'Full body — intermediate', 'Full body — no equipment',
    'Legs — bodyweight', 'Legs — intermediate', 'Low-impact cardio (no jumping)', 'Pull — bodyweight', 'Pull — no bar',
    'Pull — pull-up bar', 'Push — bodyweight', 'Push — intermediate',
  ].sort());
  for (const name of ['Dumbbell Basics', 'Dumbbell Upper Body', 'Daily Mobility', 'Core Stability', 'Walk-Jog Starter', 'Cycling Endurance']) {
    assert.equal(fitOf(get(name)).isHomeRoutine, false, name);
  }
});

test('a gym routine needs a gym, a dumbbell one needs dumbbells but no gym', () => {
  assert.equal(fitOf(get('Strength Foundations A')).needsGym, true);
  assert.equal(fitOf(get('Push Day B')).needsGym, true);
  const db = fitOf(get('Dumbbell Basics'));
  assert.equal(db.needsGym, false);
  assert.deepEqual(db.equipmentNeeded, ['dumbbells']);
  assert.deepEqual(fitOf(get('Quick Home Session')).equipmentNeeded, []);
});
