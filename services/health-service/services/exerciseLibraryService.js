import prisma from '../db/prisma.js';
import { MUSCLE_GROUPS, EQUIPMENT, LOGGING_TYPES } from '../constants/healthEnums.js';
import { rankExercises } from './exerciseSearch.js';
import { createTtlCache } from '../utils/ttlCache.js';
import { withExerciseSource } from './exerciseSourceService.js';

// The library is global (createdByUserId: null) plus this user's own custom
// entries — never another user's custom exercises, which is what the OR
// clause below enforces.
//
// The global catalogue is the same for everyone and only changes when
// prisma/seed.js is run (no API writes a createdByUserId-null exercise), so it
// is cached in-process for 10 minutes per instance - a reseed shows up on an
// instance within the TTL or at its next restart. Only the caller's own custom
// exercises are queried per request. Muscle/equipment filters are applied to the
// cached catalogue in JS with the same equality the query used.
export const SYSTEM_EXERCISES_TTL_MS = 10 * 60_000;
export const systemExercisesCache = createTtlCache({ ttlMs: SYSTEM_EXERCISES_TTL_MS, maxEntries: 1 });
const loadSystemExercises = () => systemExercisesCache.get('system', () => prisma.exercise.findMany({
  where: { createdByUserId: null },
  orderBy: { name: 'asc' },
}));

export async function searchExercisesService(userId, { q, muscleGroup, equipment } = {}) {
  const [system, custom] = await Promise.all([
    loadSystemExercises(),
    prisma.exercise.findMany({
      where: {
        AND: [
          { createdByUserId: userId },
          muscleGroup ? { muscleGroup } : {},
          equipment ? { equipment } : {},
        ],
      },
      orderBy: { name: 'asc' },
    }),
  ]);
  const fits = (e) => (!muscleGroup || e.muscleGroup === muscleGroup) && (!equipment || e.equipment === equipment);
  // rankExercises fully re-sorts (score, then name), so merge order only matters
  // between identically-named rows.
  return rankExercises([...system.filter(fits), ...custom], q);
}

export async function createCustomExerciseService(userId, body) {
  const { name, muscleGroup, equipment, loggingType } = body || {};
  if (!name || !muscleGroup || !equipment || !loggingType) {
    const err = new Error('name, muscleGroup, equipment and loggingType are required');
    err.status = 400;
    throw err;
  }
  if (!MUSCLE_GROUPS.includes(muscleGroup)) {
    const err = new Error('Invalid muscleGroup');
    err.status = 400;
    throw err;
  }
  if (!EQUIPMENT.includes(equipment)) {
    const err = new Error('Invalid equipment');
    err.status = 400;
    throw err;
  }
  if (!LOGGING_TYPES.includes(loggingType)) {
    const err = new Error('Invalid loggingType');
    err.status = 400;
    throw err;
  }
  // Custom exercises ship with no muscle-diagram data or demo/video content —
  // the exercise-detail screen has its own empty state for this, per the
  // implementation plan's note on the Exercise model.
  return prisma.exercise.create({
    data: { name, muscleGroup, equipment, loggingType, createdByUserId: userId, primaryMuscles: [], secondaryMuscles: [] },
  });
}

// Personal records (heaviest weight / best-set volume / est. 1RM — the
// exact metrics Hevy's own exercise-detail stats surface, per the UI/UX
// section's research) computed live from this user's completed sets for
// this exercise, not stored — cheap to compute, and always exactly correct
// even if a past set is edited or deleted.
async function computePersonalRecords(userId, exerciseId) {
  const sets = await prisma.workoutSet.findMany({
    where: {
      completed: true,
      weightKg: { not: null },
      reps: { not: null },
      sessionExercise: { exerciseId, session: { userId } },
    },
    select: { weightKg: true, reps: true },
  });
  if (sets.length === 0) return { heaviestWeightKg: null, bestSetVolumeKg: null, estimated1RmKg: null };
  let heaviest = 0;
  let bestVolume = 0;
  let best1Rm = 0;
  for (const s of sets) {
    const weight = Number(s.weightKg);
    const volume = weight * s.reps;
    // Epley formula — the standard, simplest estimated-1RM approximation;
    // good enough for a motivational stat, not a load-prescription tool.
    const oneRm = weight * (1 + s.reps / 30);
    if (weight > heaviest) heaviest = weight;
    if (volume > bestVolume) bestVolume = volume;
    if (oneRm > best1Rm) best1Rm = oneRm;
  }
  return {
    heaviestWeightKg: heaviest,
    bestSetVolumeKg: bestVolume,
    estimated1RmKg: Math.round(best1Rm * 10) / 10,
  };
}

export async function getExerciseDetailService(userId, exerciseId, lang) {
  const videoLanguage = lang ? String(lang).replace('_', '-').toLowerCase().split('-')[0] : undefined;
  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      formVideos: {
        where: videoLanguage ? { languageCode: videoLanguage } : undefined,
        orderBy: { order: 'asc' },
      },
    },
  });
  if (!exercise || (exercise.createdByUserId && exercise.createdByUserId !== userId)) {
    const err = new Error('Exercise not found');
    err.status = 404;
    throw err;
  }
  const records = await computePersonalRecords(userId, exerciseId);
  const enriched = withExerciseSource(exercise, lang);
  // Keep real English instruction available when a translation is absent.
  // Preserve each video's actual language; clients label the returned cards.
  if (videoLanguage && videoLanguage !== 'en' && !enriched.formVideos?.length) {
    const english = await prisma.exerciseFormVideo.findMany({
      where: { exerciseId: exercise.id, languageCode: 'en' }, orderBy: { order: 'asc' },
    });
    if (english.length) return { ...enriched, formVideos: english, formVideoRequestedLanguage: videoLanguage, formVideoFallbackLanguage: 'en', records };
  }
  return { ...enriched, records };
}

// Every logged set for this exercise across sessions, oldest -> newest —
// powers the exercise-detail progress sparkline and the "view full history"
// link into Training Progress.
export async function getExerciseHistoryService(userId, exerciseId) {
  const sets = await prisma.workoutSet.findMany({
    where: { completed: true, sessionExercise: { exerciseId, session: { userId } } },
    include: { sessionExercise: { include: { session: { select: { startedAt: true } } } } },
  });
  // Sorted in JS rather than a nested-relation orderBy — simpler to reason
  // about across two hops of to-one relations, and this list is small
  // (one user's sets for one exercise, not a table scan).
  return sets.sort(
    (a, b) => a.sessionExercise.session.startedAt - b.sessionExercise.session.startedAt,
  );
}
