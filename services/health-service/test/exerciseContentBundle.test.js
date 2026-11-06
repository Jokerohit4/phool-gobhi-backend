import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExerciseContentBundles, applyExerciseContentBundle, verifyExerciseBundleAssets } from '../utils/exerciseContentBundle.js';
const catalogue = [{ name: 'Paused Squat', equipment: 'barbell' }];
const packageFor = () => ({
  exerciseName: 'Paused Squat', equipment: 'barbell', reviewStatus: 'approved', reviewedBy: 'Trainer', reviewedAt: '2026-11-05T00:00:00Z',
  rights: 'owned', rightsEvidence: 'Contract reference', attribution: 'Phool Gobhi',
  imageUrl: 'https://cdn.example.com/paused-squat.jpg', demoGifUrl: 'https://cdn.example.com/paused-squat.gif',
  demoVideoUrl: 'https://cdn.example.com/paused-squat-demo.mp4', tutorialVideoUrl: 'https://cdn.example.com/paused-squat-guide.mp4',
  hasInstructionalExplanation: true, tutorialLanguage: 'en', tutorialDurationSeconds: 45, videoCodec: 'h264',
  instructions: { en: ['Setup.', 'Pause.', 'Return.'], hi: ['Setup in Hindi.', 'Pause in Hindi.', 'Return in Hindi.'] },
  secondaryMuscles: [], emptySecondaryMusclesReason: 'Reviewed list intentionally omits supporting muscles.',
  classification: { difficulty: { value: 'intermediate', basis: 'Trainer review' }, force: { value: 'push', basis: 'Trainer review' }, mechanic: { value: 'compound', basis: 'Trainer review' } },
});

test('missing uploads and HTML error pages cannot masquerade as completed media', async () => {
  const responses = (url) => Promise.resolve({ ok: true, status: 200,
    headers: new Headers({ 'content-type': url.endsWith('.jpg') ? 'image/jpeg' : url.endsWith('.gif') ? 'image/gif' : 'video/mp4' }) });
  await verifyExerciseBundleAssets([packageFor()], responses);
  await assert.rejects(verifyExerciseBundleAssets([packageFor()], async () => ({ ok: false, status: 404, headers: new Headers() })), /unavailable/);
  await assert.rejects(verifyExerciseBundleAssets([packageFor()], async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }) })), /invalid media/);
});

test('incomplete, unreviewed, unlicensed or mismatched batches cannot be imported', () => {
  assert.equal(validateExerciseContentBundles([packageFor()], catalogue).length, 1);
  for (const edit of [{ demoGifUrl: null }, { reviewStatus: 'pending' }, { equipment: 'dumbbell' }, { rightsEvidence: '' }, { hasInstructionalExplanation: false }, { emptySecondaryMusclesReason: '' }]) {
    assert.throws(() => validateExerciseContentBundles([{ ...packageFor(), ...edit }], catalogue));
  }
  assert.throws(() => validateExerciseContentBundles([packageFor(), packageFor()], catalogue), /Duplicate/);
});

test('approved packages fill each capability without changing IDs or tutorial language', () => {
  const bundle = packageFor();
  const original = { ...catalogue[0], id: 77, createdByUserId: null };
  const english = applyExerciseContentBundle(original, bundle, 'en');
  assert.equal(english.id, 77);
  assert.equal(english.formVideos[0].kind, 'tutorial');
  assert.equal(english.demoVideos[0].kind, 'demo');
  assert.equal(english.sourceMetadata.owned.reviewedBy, undefined, 'internal reviewer identity is not added to the public API');
  const hindi = applyExerciseContentBundle(original, bundle, 'hi');
  assert.deepEqual(hindi.sourceInstructions, bundle.instructions.hi);
  assert.equal(hindi.formVideos.length, 0, 'English footage is not labelled as Hindi');
  const privateRow = { ...original, createdByUserId: 42 };
  assert.equal(applyExerciseContentBundle(privateRow, bundle), privateRow);
});
