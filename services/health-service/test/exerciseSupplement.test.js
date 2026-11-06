import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
import { validateHasanDataset } from '../utils/hasanExerciseDataset.js';
const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
const full = validateHasanDataset(read('sources/hasaneyldrm-exercises-dataset.json'));
const supplements = read('exerciseSupplements.json');
const catalogue = read('exerciseCatalogue.json');
const exercise = (name) => ({ ...catalogue.find((row) => row.name === name), id: 123, createdByUserId: null });

test('retains all 1324 records and generates only source-backed media and translations', () => {
  assert.equal(full.length, 1324);
  assert.equal(Object.keys(supplements).length, 488);
  for (const [name, supplement] of Object.entries(supplements)) {
    const original = full.find((row) => row.id === supplement.sourceId);
    assert.ok(original, name);
    assert.ok(supplement.gifUrl.endsWith('/' + original.gif_url));
    assert.ok(supplement.imageUrl.endsWith('/' + original.image));
    const decision = read('sources/hasaneyldrm-reviewed-mappings.json').selected[name];
    if (decision?.useInstructions === false) {
      assert.ok(Object.values(supplement.instructionsByLanguage).every((steps) => steps.length === 0));
    } else assert.deepEqual(supplement.instructionsByLanguage, original.instruction_steps);
    assert.equal(supplement.mediaAttribution, original.attribution);
    assert.equal(supplement.equipment, exercise(name).equipment);
  }
});

test('media-only review does not publish instructions with the wrong bench setup', () => {
  const result = withExerciseSource(exercise('Barbell Rollout from Bench'), 'hi');
  assert.match(result.demoGifUrl, /0083-.*\.gif$/);
  assert.equal(result.sourceInstructionLanguage, 'en');
  assert.match(result.sourceInstructions[0], /Kneel with both legs on the bench/);
  assert.match(result.sourceInstructionAttribution, /Unlicense/);
});

test('provides real GIFs, Hindi steps, and source credit for a newly filled exercise', () => {
  const result = withExerciseSource(exercise('Knee Push-up'), 'hi');
  assert.match(result.demoGifUrl, /3211-.*\.gif$/);
  assert.equal(result.sourceInstructionLanguage, 'hi');
  assert.deepEqual(result.sourceInstructions, supplements['Knee Push-up'].instructionsByLanguage.hi);
  assert.match(result.mediaAttribution, /Gym visual/);
  assert.match(result.sourceInstructionAttribution, /MIT/);
  assert.ok(result.secondaryMuscles.length > 0);
});

test('preserves valid existing demos and muscle metadata; labels English fallback honestly', () => {
  const row = { ...exercise('Barbell Bench Press'), demoGifUrl: 'https://cdn.example.com/custom.gif', mediaAttribution: 'Existing credit', secondaryMuscles: ['Existing muscle'] };
  const result = withExerciseSource(row, 'hi');
  assert.equal(result.demoGifUrl, row.demoGifUrl);
  assert.equal(result.mediaAttribution, row.mediaAttribution);
  assert.deepEqual(result.secondaryMuscles, row.secondaryMuscles);
  assert.equal(result.sourceInstructionLanguage, 'hi');
  assert.equal(withExerciseSource(row, 'hi_Latn').sourceInstructionLanguage, 'en');
  assert.equal(withExerciseSource(exercise('Plank'), 'hi').sourceInstructionLanguage, 'en');
});

test('empty free-source instructions remain safe, and private/equipment variants remain isolated', () => {
  assert.ok(Array.isArray(withExerciseSource(exercise('Side Jackknife'), 'hi').sourceInstructions));
  const row = { ...exercise('Knee Push-up'), createdByUserId: 7 };
  assert.equal(withExerciseSource(row, 'hi'), row);
  const incompatible = { ...exercise('Knee Push-up'), equipment: 'cable' };
  assert.equal(withExerciseSource(incompatible), incompatible);
  assert.equal(supplements['Assisted Pistol Squat'], undefined);
});
