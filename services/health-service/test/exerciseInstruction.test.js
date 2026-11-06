import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
import { withExerciseInstructionFallback } from '../services/exerciseInstructionService.js';

const catalogue = JSON.parse(readFileSync(new URL('../prisma/exerciseCatalogue.json', import.meta.url), 'utf8'));
const media = JSON.parse(readFileSync(new URL('../prisma/exerciseMedia.json', import.meta.url), 'utf8'));

test('all catalogue exercises have real instruction text and preserve media', () => {
  for (const exercise of catalogue) {
    const result = withExerciseSource({ ...exercise, demoGifUrl: media[exercise.name]?.gifUrl, demoImageUrl: media[exercise.name]?.imageUrl });
    assert.ok(result.sourceInstructions?.length, exercise.name);
    assert.ok(result.sourceInstructions.every((step) => typeof step === 'string' && step.trim()), exercise.name);
    assert.ok(result.demoGifUrl && result.demoImageUrl, exercise.name);
  }
});

test('fallbacks distinguish licensed text from original guidance and label English fallback honestly', () => {
  const sourced = withExerciseSource({ name: 'Air Bike', equipment: 'machine' }, 'hi');
  assert.equal(sourced.sourceInstructionLanguage, 'en');
  assert.match(sourced.sourceInstructionAttribution, /RepDB/);
  assert.equal(sourced.sourceMetadata.instructionFallback.rights, 'repdb_free_in_app');
  const original = withExerciseSource({ name: 'Walking Lunge', equipment: 'dumbbell' });
  assert.match(original.sourceInstructions[0], /dumbbell in each hand/);
  assert.match(original.sourceInstructionAttribution, /original English/);
  assert.equal(original.sourceInstructionUrl, null);
  assert.equal(original.instructions, undefined);
  assert.equal(original.approvalStatus, undefined);
});

test('existing source steps, private exercises and equipment mismatches are never overwritten', () => {
  for (const exercise of [
    { name: 'Air Bike', equipment: 'machine', sourceInstructions: ['Existing curated source'] },
    { name: 'Air Bike', equipment: 'machine', createdByUserId: 42 },
    { name: 'Air Bike', equipment: 'barbell' },
  ]) assert.equal(withExerciseInstructionFallback(exercise), exercise);
});

test('known mismatched English steps are corrected with honest credit and retained provenance', () => {
  const corrected = withExerciseSource({ name: 'Close-Grip Dumbbell Press', equipment: 'dumbbell', instructions: ['Existing coach steps'] });
  assert.match(corrected.sourceInstructions[0], /lengthways/);
  assert.match(corrected.sourceInstructionAttribution, /Phool Gobhi/);
  assert.match(corrected.sourceMetadata.supersededInstructionSource.sourceUrl, /free-exercise-db/);
  assert.deepEqual(corrected.instructions, ['Existing coach steps']);
  const hindi = { name: 'Close-Grip Dumbbell Press', equipment: 'dumbbell', sourceInstructions: ['Existing Hindi guidance'], sourceInstructionLanguage: 'hi' };
  assert.equal(withExerciseInstructionFallback(hindi), hindi);
});

test('known towel-row source mismatch gets anchored guidance in English and Hindi requests only for that source', () => {
  for (const language of ['en', 'hi']) {
    const corrected = withExerciseSource({ name: 'Towel Row', equipment: 'bodyweight' }, language);
    assert.match(corrected.sourceInstructions[0], /fixed support/);
    assert.equal(corrected.sourceInstructionLanguage, 'en');
    assert.equal(corrected.sourceMetadata.supersededInstructionSource.language, language);
    assert.match(corrected.sourceMetadata.supersededInstructionSource.sourceUrl, /hasaneyldrm/);
  }
  const unrelated = { name: 'Towel Row', equipment: 'bodyweight', sourceInstructions: ['Reviewed Hindi source'], sourceInstructionLanguage: 'hi', sourceInstructionUrl: 'https://example.com/new-reviewed-guide' };
  assert.equal(withExerciseInstructionFallback(unrelated), unrelated);
});
