import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
const catalogue = read('exerciseCatalogue.json');
const profiles = read('exerciseReferenceData.json');
const row = (name) => ({ ...catalogue.find((entry) => entry.name === name), id: 123, createdByUserId: null });

test('reference aliases fill actual movement gaps and preserve the canonical ID', () => {
  const result = withExerciseSource(row('Barbell Floor Press'));
  assert.equal(result.id, 123);
  assert.ok(result.sourceImageUrls[0].includes('/Floor_Press/'));
  assert.ok(result.sourceInstructions.length);
  assert.equal(result.sourceMetadata.references.classification.difficulty, 'intermediate');
  const catCow = withExerciseSource(row('Cat-Cow'));
  assert.ok(catCow.sourceInstructions.join(' ').includes('cat'));
  assert.ok(catCow.sourceInstructionAttribution.includes('CC-BY-SA'));
});

test('only reviewed hold imagery and compatible rights-cleared video are published', () => {
  const plank = withExerciseSource(row('Side Plank'));
  assert.equal(plank.sourceImageUrls.length, 1);
  assert.ok(plank.sourceImageUrls[0].endsWith('/Side_Bridge/1.jpg'));
  assert.deepEqual(profiles['Bird Dog'].images, []);
  assert.deepEqual(profiles['Dumbbell Hip Thrust'].images, []);
  assert.deepEqual(profiles['Paused Squat'].instructions, [], 'ordinary squat instructions must not pretend to teach the pause');
  const bench = withExerciseSource(row('Barbell Bench Press'));
  assert.equal(bench.demoVideos[0].kind, 'demo');
  assert.ok(bench.demoVideos[0].videoUrl.toLowerCase().endsWith('.mp4'));
  assert.ok(bench.demoVideos[0].attribution.includes('CC-BY-SA'));
  assert.ok(!bench.demoVideos[0].videoUrl.includes('r2.dev'), 'unproven video-rights source is excluded');
});

test('existing approved data and private exercise ownership are preserved', () => {
  const existing = { ...row('Barbell Floor Press'), sourceInstructions: ['Existing coaching'], sourceImageUrls: ['https://example.test/existing.jpg'] };
  const result = withExerciseSource(existing);
  assert.deepEqual(result.sourceInstructions, existing.sourceInstructions);
  assert.deepEqual(result.sourceImageUrls, existing.sourceImageUrls);
  const privateRow = { ...existing, createdByUserId: 7 };
  assert.equal(withExerciseSource(privateRow), privateRow);
  const mismatch = { ...row('Barbell Floor Press'), equipment: 'dumbbell' };
  assert.equal(withExerciseSource(mismatch), mismatch);
});
