import { PrismaClient } from '@prisma/client';
import { MUSCLE_GROUPS, EQUIPMENT, LOGGING_TYPES } from '../constants/healthEnums.js';
const prisma = new PrismaClient();

// The library is global (createdByUserId: null) plus this user's own custom
// entries — never another user's custom exercises, which is what the OR
// clause below enforces.
export async function searchExercisesService(userId, { q, muscleGroup, equipment } = {}) {
  const where = {
    AND: [
      { OR: [{ createdByUserId: null }, { createdByUserId: userId }] },
      q ? { name: { contains: q, mode: 'insensitive' } } : {},
      muscleGroup ? { muscleGroup } : {},
      equipment ? { equipment } : {},
    ],
  };
  return prisma.exercise.findMany({ where, orderBy: { name: 'asc' } });
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
  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    include: {
      formVideos: {
        where: lang ? { languageCode: lang } : undefined,
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
  return { ...exercise, records };
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
