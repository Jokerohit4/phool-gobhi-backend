// Home setup (onboarding audit P2): what a home-track user trains with, asked
// at the first "Start workout". These pin the rules that make it more than a
// stored answer — the routine fit, the fits-first ordering and the coach line
// — and the validation that keeps it a fixed vocabulary.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  equipmentFit, rankByFit, summariseHomeSetup,
  validateHomeEquipment, validateTrainingSpace,
} from '../services/homeSetup.js';

const answered = (homeEquipment, trainingSpace = null) => ({
  homeSetupAt: new Date('2026-10-01T00:00:00Z'), homeEquipment, trainingSpace,
});
const tpl = (name, ...equipment) => ({
  name, exercises: equipment.map((e) => ({ exercise: { equipment: e } })),
});

test('unknown setup is null, not "fits" — nothing may claim a match', () => {
  assert.equal(equipmentFit(tpl('a', 'dumbbell'), null), null);
  assert.equal(equipmentFit(tpl('a', 'dumbbell'), { homeEquipment: ['dumbbells'] }), null,
    'fields without homeSetupAt were never answered through the sheet');
});

test('bodyweight routines fit anyone who answered, including "no equipment"', () => {
  assert.deepEqual(equipmentFit(tpl('squats', 'bodyweight', 'other'), answered(['none'])),
    { fits: true, missing: [] });
  assert.deepEqual(equipmentFit(tpl('squats', 'bodyweight'), answered([])),
    { fits: true, missing: [] });
});

test('a dumbbell routine is missing dumbbells for someone without them', () => {
  assert.deepEqual(equipmentFit(tpl('rows', 'dumbbell', 'bodyweight'), answered(['resistance_bands'])),
    { fits: false, missing: ['dumbbells'] });
  assert.equal(equipmentFit(tpl('rows', 'dumbbell'), answered(['dumbbells'])).fits, true);
});

test('gym-only kit maps to a full home gym, which covers everything', () => {
  assert.deepEqual(equipmentFit(tpl('bench', 'barbell', 'cable'), answered(['dumbbells'])),
    { fits: false, missing: ['full_home_gym'] });
  assert.equal(equipmentFit(tpl('mixed', 'barbell', 'kettlebell', 'dumbbell'), answered(['full_home_gym'])).fits, true);
});

test('fits-first is a stable partition, and a no-op when unknown', () => {
  const list = [tpl('A', 'dumbbell'), tpl('B', 'bodyweight'), tpl('C', 'barbell'), tpl('D', 'bodyweight')];
  assert.deepEqual(rankByFit(list, answered(['none'])).map((t) => t.name), ['B', 'D', 'A', 'C']);
  assert.deepEqual(rankByFit(list, null).map((t) => t.name), ['A', 'B', 'C', 'D']);
});

test('validation: fixed vocabulary, and "none" is exclusive', () => {
  assert.equal(validateHomeEquipment(undefined), null);
  assert.equal(validateHomeEquipment(null), null);
  assert.equal(validateHomeEquipment(['dumbbells', 'pull_up_bar']), null);
  assert.match(validateHomeEquipment(['barbell']), /subset/);
  assert.match(validateHomeEquipment('dumbbells'), /subset/);
  assert.match(validateHomeEquipment(['none', 'dumbbells']), /can't be combined/);
  assert.equal(validateTrainingSpace('small'), null);
  assert.match(validateTrainingSpace('huge'), /one of/);
});

test('coach line: fixed phrases, null until answered', () => {
  assert.equal(summariseHomeSetup(null), null);
  assert.equal(summariseHomeSetup({ homeEquipment: ['dumbbells'] }), null);
  const line = summariseHomeSetup(answered(['dumbbells', 'resistance_bands'], 'small'));
  assert.match(line, /^Home setup: has dumbbells, resistance bands; trains in a small space/);
  assert.match(summariseHomeSetup(answered(['none'])), /has no equipment/);
  // Skipped the sheet: answered, but nothing to say.
  assert.equal(summariseHomeSetup(answered([])), null);
});
