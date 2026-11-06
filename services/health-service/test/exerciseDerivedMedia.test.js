import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withDerivedExerciseMedia } from '../services/exerciseDerivedMediaService.js';
import { withExerciseSource } from '../services/exerciseSourceService.js';
const media = JSON.parse(readFileSync(new URL('../prisma/derivedExerciseMedia.json', import.meta.url), 'utf8'));

test('a reviewed motion derivative supplies missing media with its actual rights and demo kind', () => {
  const result = withExerciseSource({ id: 8, name: 'Cat-Cow', equipment: 'bodyweight', createdByUserId: null, formVideos: [{ id: 5, youtubeVideoId: 'instruction' }] });
  assert.equal(result.demoGifUrl, media['Cat-Cow'].gifUrl);
  assert.match(result.demoGifUrl, /phool-gobhi-exercise-media-dev\/references\/753723\/[a-f0-9]+\.gif$/);
  assert.deepEqual(result.sourceImageUrls, [media['Cat-Cow'].imageUrl]);
  assert.equal(result.demoVideos.at(-1).kind, 'demo');
  assert.match(result.demoVideos.at(-1).attribution, /does not imply or constitute DoW endorsement/);
  assert.equal(result.formVideos[0].youtubeVideoId, 'instruction');
  assert.match(result.sourceInstructionAttribution, /wger/);
  assert.equal(result.sourceMetadata.derivedMedia.rights, 'public_domain');
});

test('derived media preserves ownership, equipment, existing media and independent credits', () => {
  const privateRow = { id: 8, name: 'Cat-Cow', equipment: 'bodyweight', createdByUserId: 7 };
  assert.equal(withDerivedExerciseMedia(privateRow), privateRow);
  const incompatible = { ...privateRow, createdByUserId: null, equipment: 'cable' };
  assert.equal(withDerivedExerciseMedia(incompatible), incompatible);
  const result = withDerivedExerciseMedia({ ...privateRow, createdByUserId: null,
    demoGifUrl: 'https://example.test/existing.gif', mediaAttribution: 'Existing GIF provider',
    sourceImageUrls: ['https://example.test/existing.jpg'], sourceAttribution: 'Existing photo provider' });
  assert.equal(result.demoGifUrl, 'https://example.test/existing.gif');
  assert.equal(result.mediaAttribution, 'Existing GIF provider');
  assert.equal(result.sourceAttribution, 'Existing photo provider');
  assert.equal(result.formVideos, undefined);
  assert.equal(withDerivedExerciseMedia(result).demoVideos.length, 1, 'the same public demo is not duplicated');
});

test('priority motion GIFs resolve independently of tutorial availability', () => {
  for (const [name, equipment] of [['Bodyweight Squat', 'bodyweight'], ['Plank', 'bodyweight'], ['Side Plank', 'bodyweight'], ['Face Pull', 'cable'], ['Barbell Hip Thrust', 'barbell'], ['Barbell Walking Lunge', 'barbell']]) {
    const result = withExerciseSource({ id: 10, name, equipment, createdByUserId: null, formVideos: [] });
    assert.equal(result.demoGifUrl, media[name].gifUrl, name);
    assert.deepEqual(result.formVideos, [], 'motion media does not invent tutorial coverage');
    assert.equal(result.demoVideos.at(-1).videoUrl, media[name].videoUrl);
    if (media[name].provider === 'wger') {
      assert.equal(result.demoVideos.at(-1).channelName, 'wger');
      assert.match(result.mediaAttribution, /Goulart/);
      assert.match(result.mediaAttribution, /derivatives licensed CC BY-SA 4\.0/);
      assert.equal(result.demoVideos.at(-1).licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
    }
  }
});
