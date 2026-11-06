import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
import { isExerciseMediaUrl } from '../utils/exerciseMedia.js';
const pose = JSON.parse(readFileSync(new URL('../prisma/exercisePoseGifs.json', import.meta.url), 'utf8'));

test('approved pose references fill GIFs with honest type, source images and credit', () => {
  const row = { id: 13, name: 'Overhead Press', equipment: 'barbell', createdByUserId: null };
  const result = withExerciseSource(row);
  assert.equal(result.demoGifUrl, pose[row.name].gifUrl);
  assert.equal(result.demoGifKind, 'pose_sequence');
  assert.equal(result.sourceMetadata.poseSequence.frameCount, 2);
  assert.equal(result.sourceMetadata.poseSequence.sourceImageUrls.length, 2);
  assert.match(result.mediaAttribution, /Labelled photo-sequence GIF/);
  assert.ok(result.sourceInstructions.length, 'pose assets preserve the exercise guide');
  const stored = withExerciseSource({ ...row, demoGifUrl: result.demoGifUrl });
  assert.equal(stored.demoGifKind, 'pose_sequence', 'a database backfill does not relabel still poses as motion');
});

test('every public catalogue exercise resolves a GIF and photo while reference types stay honest', () => {
  const catalogue = JSON.parse(readFileSync(new URL('../prisma/exerciseCatalogue.json', import.meta.url), 'utf8'));
  const seed = JSON.parse(readFileSync(new URL('../prisma/exerciseMedia.json', import.meta.url), 'utf8'));
  assert.equal(catalogue.length, 1103);
  for (const row of catalogue) {
    const result = withExerciseSource({ ...row, demoGifUrl: seed[row.name]?.gifUrl, demoImageUrl: seed[row.name]?.imageUrl });
    assert.ok(isExerciseMediaUrl(result.demoGifUrl), `${row.name} is missing its GIF`);
    assert.ok(isExerciseMediaUrl(result.demoImageUrl), `${row.name} is missing its photo`);
    if (pose[row.name] && result.demoGifUrl === pose[row.name].gifUrl) {
      assert.equal(result.demoGifKind, pose[row.name].kind);
      assert.ok(result.sourceMetadata.poseSequence.frameCount >= 1);
    }
  }
  const schematic = withExerciseSource({ name: 'March in Place', equipment: 'bodyweight' });
  assert.equal(schematic.demoGifKind, 'schematic_pose_sequence');
  assert.match(schematic.mediaAttribution, /original schematic/);
  const hold = withExerciseSource({ name: 'High Plank', equipment: 'bodyweight' });
  assert.equal(hold.demoGifKind, 'hold_reference');
  assert.equal(hold.sourceMetadata.poseSequence.frameCount, 1);
});

test('real motion wins over pose references; private and equipment variants remain isolated', () => {
  const row = { id: 13, name: 'Overhead Press', equipment: 'barbell', createdByUserId: null,
    demoGifUrl: 'https://example.test/coach-motion.gif', mediaAttribution: 'Existing coach' };
  const result = withExerciseSource(row);
  assert.equal(result.demoGifUrl, row.demoGifUrl);
  assert.equal(result.mediaAttribution, 'Existing coach');
  assert.equal(result.demoGifKind, 'motion');
  const privateRow = { ...row, createdByUserId: 5 };
  assert.equal(withExerciseSource(privateRow), privateRow);
  assert.equal(withExerciseSource({ ...row, equipment: 'cable', demoGifUrl: null }).demoGifUrl, null);
  const upgraded = withExerciseSource({ name: 'Cat-Cow', equipment: 'bodyweight', createdByUserId: null,
    demoGifUrl: pose['Overhead Press'].gifUrl });
  assert.match(upgraded.demoGifUrl, /\/references\/753723\//, 'a newly available real motion asset replaces a stored pose fallback');
});
