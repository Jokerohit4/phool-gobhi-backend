import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let row;
let requested;
let englishVideos;
let fallbackCalls;
beforeEach(() => { englishVideos = []; fallbackCalls = []; });
mock.module('@prisma/client', { namedExports: { PrismaClient: class {
  exercise = { findUnique: async (args) => { requested = args; return row; } };
  exerciseFormVideo = { findMany: async (args) => { fallbackCalls.push(args); return englishVideos; } };
  workoutSet = { findMany: async ({ where }) => {
    assert.equal(where.sessionExercise.session.userId, 7);
    return [];
  } };
} } });
const { getExerciseDetailService } = await import('../services/exerciseLibraryService.js');

test('exercise detail includes source photos and preserves records and language filtering', async () => {
  row = { id: 8, name: 'Plank', equipment: 'bodyweight', createdByUserId: null, formVideos: [] };
  const detail = await getExerciseDetailService(7, 8, 'hi');
  assert.equal(detail.sourceImageUrls.length, 2);
  assert.ok(detail.sourceInstructions.length);
  assert.deepEqual(detail.formVideos, []);
  assert.equal(detail.records.heaviestWeightKg, null);
  assert.deepEqual(requested.include.formVideos.where, { languageCode: 'hi' });
});

test('private exercises retain ownership checks and do not receive public source content', async () => {
  row = { id: 9, name: 'Plank', equipment: 'bodyweight', createdByUserId: 99 };
  await assert.rejects(getExerciseDetailService(7, 9), { status: 404 });
  assert.equal(fallbackCalls.length, 0, 'ownership is checked before reading fallback content');
  row.createdByUserId = 7;
  const detail = await getExerciseDetailService(7, 9);
  assert.equal(detail.sourceInstructions, undefined);
  assert.equal(detail.sourceImageUrls, undefined);
});

test('missing Hindi tutorials expose labelled English fallback without changing source-guide language', async () => {
  row = { id: 8, name: 'Barbell Bench Press', equipment: 'barbell', createdByUserId: null, formVideos: [] };
  englishVideos = [{ id: 80, languageCode: 'en', youtubeVideoId: 'real-trainer', title: 'Actual English guide' }];
  const result = await getExerciseDetailService(7, 8, 'hi');
  assert.deepEqual(result.formVideos, englishVideos);
  assert.equal(result.formVideoFallbackLanguage, 'en');
  assert.equal(result.formVideoRequestedLanguage, 'hi');
  assert.equal(result.formVideos[0].languageCode, 'en');
  assert.deepEqual(fallbackCalls[0].where, { exerciseId: 8, languageCode: 'en' });
  assert.equal(result.sourceInstructionLanguage, 'hi');
});

test('actual Hindi tutorials win and regional English requests use English directly', async () => {
  const hindi = [{ id: 81, languageCode: 'hi', youtubeVideoId: 'real-hindi-trainer' }];
  row = { id: 8, name: 'Plank', equipment: 'bodyweight', createdByUserId: null, formVideos: hindi };
  const result = await getExerciseDetailService(7, 8, 'hi');
  assert.deepEqual(result.formVideos, hindi);
  assert.equal(result.formVideoFallbackLanguage, undefined);
  assert.equal(fallbackCalls.length, 0);
  await getExerciseDetailService(7, 8, 'en-IN');
  assert.deepEqual(requested.include.formVideos.where, { languageCode: 'en' });
  assert.equal(fallbackCalls.length, 0);
});
