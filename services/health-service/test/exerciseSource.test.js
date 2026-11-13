import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
const catalogue = read('exerciseCatalogue.json');
const base = read('sources/catalogue-base.json');
const source = read('sources/free-exercise-db.json');
const mappings = read('exerciseSources.json');
const report = read('sources/import-report.json');
const find = (name) => catalogue.find((e) => e.name === name);

test('import preserves every original definition and adds distinct source movements', () => {
  assert.equal(catalogue.length, 1103);
  assert.equal(catalogue.length - base.length, 795);
  for (const original of base) {
    const { aliases: _, ...expected } = original;
    const { aliases: __, ...actual } = find(original.name);
    assert.deepEqual(actual, expected);
    assert.ok(original.aliases.every((a) => find(original.name).aliases.includes(a)));
  }
  const normalized = catalogue.map((e) => e.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  assert.equal(new Set(normalized).size, catalogue.length, 'no punctuation/case duplicates');
  for (const entry of source) assert.ok(report.decisions.some((d) => d.source === entry.name && mappings[d.exercise]), entry.id);
  assert.ok(find('Axle Deadlift'));
  assert.equal(find('90/90 Hamstring').loggingType, 'duration');
  assert.equal(find('Kettlebell Halo with Overhead Extension').equipment, 'kettlebell');
  assert.equal(find('Split Squat Stretch').loggingType, 'duration');
  assert.equal(find('Band Squat').equipment, 'other');
  assert.equal(find('Squat with Bands').equipment, 'barbell');
});

test('floor bicycle crunch and kettlebell goblet squat cannot replace other equipment variants', () => {
  assert.equal(find('Air Bike').equipment, 'machine');
  assert.equal(find('Air Bike (Bicycle Crunch)').equipment, 'bodyweight');
  assert.equal(find('Goblet Squat').equipment, 'dumbbell');
  assert.equal(find('Kettlebell Goblet Squat').equipment, 'kettlebell');
  assert.equal(withExerciseSource({ ...find('Air Bike'), id: 1 }).sourceImageUrls, undefined);
  assert.equal(withExerciseSource({ ...find('Goblet Squat'), id: 2 }).sourceMetadata.hasaneyldrm.equipment, 'dumbbell');
  assert.equal(withExerciseSource({ ...find('Kettlebell Goblet Squat'), id: 3 }).sourceImageUrls.length, 2);
});

test('broken demos use reviewed motion while photos retain their source and valid uploads stay preferred', () => {
  const original = { ...find('Plank'), id: 12, demoGifUrl: 'https://cloudinary.com{CLOUD_NAME}/plank', demoImageUrl: 'bad' };
  const result = withExerciseSource(original);
  assert.equal(result.id, 12);
  assert.match(result.demoGifUrl, /^https:\/\/storage\.googleapis\.com\/phool-gobhi-exercise-media-dev\/references\/640237\/[a-f0-9]+\.gif$/);
  assert.equal(result.sourceImageUrls.length, 2);
  assert.ok(result.sourceImageUrls[0].endsWith('/Plank/0.jpg'));
  assert.equal(result.demoImageUrl, result.sourceImageUrls[0]);
  assert.ok(result.sourceInstructions.length);
  assert.match(result.sourceAttribution, /free-exercise-db/);
  const gif = 'https://cdn.example.com/plank.gif';
  const image = 'https://cdn.example.com/plank.jpg';
  const uploaded = withExerciseSource({ ...original, demoGifUrl: gif, demoImageUrl: image });
  assert.equal(uploaded.demoGifUrl, gif);
  assert.equal(uploaded.demoImageUrl, image);
  assert.equal(original.demoImageUrl, 'bad', 'no mutation of cached rows');
});

test('private, unknown and incompatible exercises never inherit public content', () => {
  for (const row of [
    { ...find('Plank'), createdByUserId: 42 },
    { ...find('Plank'), equipment: 'machine' },
    { name: 'An unknown exercise', equipment: 'bodyweight' },
  ]) assert.equal(withExerciseSource(row), row);
  const halo = withExerciseSource(find('Kettlebell Halo'));
  assert.match(halo.sourceImageUrls[0], /^https:\/\/storage\.googleapis\.com\/phool-gobhi-exercise-media-dev\/pose-references\//);
  assert.match(halo.mediaAttribution, /Exercise data by RepDB/);
  assert.equal(halo.demoGifKind, 'pose_sequence');
  assert.ok(!halo.sourceImageUrls.some((url) => url.includes('/Kettlebell_Halo/')), 'empty upstream photo lists do not produce guessed source paths');
});

test('generated data migration only inserts missing global exercises', () => {
  const sql = readFileSync(new URL('../prisma/migrations/20261104120000_free_exercise_db_catalogue/migration.sql', import.meta.url), 'utf8');
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /e\."createdByUserId" IS NULL/);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|TRUNCATE|DROP)\b/im);
  assert.match(sql, /''/);
});
