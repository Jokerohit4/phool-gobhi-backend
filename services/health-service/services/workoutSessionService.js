import { PrismaClient } from '@prisma/client';
import { notifyWorkoutFinished } from '../utils/notifyChallengeService.js';
const prisma = new PrismaClient();

const includeFull = {
  exercises: {
    include: { exercise: true, sets: { orderBy: { setNumber: 'asc' } } },
    orderBy: { order: 'asc' },
  },
};

async function assertOwnsSession(sessionId, userId) {
  const session = await prisma.workoutSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    const err = new Error('Session not found');
    err.status = 404;
    throw err;
  }
  return session;
}

// For every exercise in this session, finds the most recent PRIOR session
// (any template, any time before this one started) that trained the same
// exercise, and returns a setNumber -> {weightKg, reps} map from it — the
// active-workout screen's ghost/pre-fill text, i.e. Strong's "previous
// performance overlay," the single most important feature in any strength
// app per the UI/UX section's research. Sorted in JS (see
// exerciseLibraryService for why nested-relation orderBy is avoided here).
async function attachPreviousPerformance(session) {
  const exercisesWithPrevious = await Promise.all(
    session.exercises.map(async (se) => {
      const priorSessions = await prisma.sessionExercise.findMany({
        where: {
          exerciseId: se.exerciseId,
          session: { userId: session.userId, startedAt: { lt: session.startedAt } },
        },
        include: { sets: { where: { completed: true } }, session: { select: { startedAt: true } } },
      });
      const mostRecent = priorSessions.sort(
        (a, b) => b.session.startedAt - a.session.startedAt,
      )[0];
      const previousBySetNumber = {};
      for (const s of mostRecent?.sets || []) {
        previousBySetNumber[s.setNumber] = { weightKg: s.weightKg, reps: s.reps };
      }
      return {
        ...se,
        sets: se.sets.map((s) => ({ ...s, previous: previousBySetNumber[s.setNumber] || null })),
      };
    }),
  );
  return { ...session, exercises: exercisesWithPrevious };
}

// Starting from a template pre-populates every SessionExercise/WorkoutSet
// row from its targets (targetSets rows per exercise, each carrying the
// previous-performance ghost values) — so the active-workout screen has
// something to render immediately, before the user taps anything.
// templateId omitted entirely means an "empty workout": zero exercises,
// added one at a time via POST /sessions/:id/exercises.
export async function startSessionService(userId, templateId) {
  if (!templateId) {
    return prisma.workoutSession.create({ data: { userId }, include: includeFull });
  }
  const template = await prisma.workoutTemplate.findUnique({
    where: { id: templateId },
    include: { exercises: { orderBy: { order: 'asc' } } },
  });
  if (!template || template.userId !== userId) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  const session = await prisma.workoutSession.create({
    data: {
      userId,
      templateId,
      exercises: {
        create: template.exercises.map((te) => ({
          exerciseId: te.exerciseId,
          order: te.order,
          supersetGroup: te.supersetGroup,
          sets: {
            create: Array.from({ length: te.targetSets }, (_, i) => ({ setNumber: i + 1 })),
          },
        })),
      },
    },
    include: includeFull,
  });
  return attachPreviousPerformance(session);
}

export async function listSessionsService(userId) {
  return prisma.workoutSession.findMany({
    where: { userId },
    include: includeFull,
    orderBy: { startedAt: 'desc' },
  });
}

export async function getSessionDetailService(sessionId, userId) {
  await assertOwnsSession(sessionId, userId);
  const session = await prisma.workoutSession.findUnique({ where: { id: sessionId }, include: includeFull });
  return attachPreviousPerformance(session);
}

// The whole active-workout interaction: tap the checkmark, this fires.
// Not batched client-side — every set saves immediately, so killing the
// app mid-workout never loses a logged set (per the implementation plan's
// verification section).
export async function updateSetService(sessionId, setId, userId, body) {
  const session = await assertOwnsSession(sessionId, userId);
  if (session.endedAt) {
    const err = new Error('Session already finished');
    err.status = 409;
    throw err;
  }
  const set = await prisma.workoutSet.findUnique({
    where: { id: setId },
    include: { sessionExercise: true },
  });
  if (!set || set.sessionExercise.sessionId !== sessionId) {
    const err = new Error('Set not found');
    err.status = 404;
    throw err;
  }
  const { weightKg, reps, durationSeconds, distanceMeters, completed } = body || {};
  return prisma.workoutSet.update({
    where: { id: setId },
    data: {
      ...(weightKg !== undefined ? { weightKg } : {}),
      ...(reps !== undefined ? { reps } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(distanceMeters !== undefined ? { distanceMeters } : {}),
      ...(completed !== undefined ? { completed } : {}),
    },
  });
}

// Adds an exercise mid-workout (from the picker) that wasn't in the
// template — starts with one empty, uncompleted set, same as a
// template-sourced exercise's first set would.
export async function addExerciseToSessionService(sessionId, userId, exerciseId) {
  const session = await assertOwnsSession(sessionId, userId);
  if (session.endedAt) {
    const err = new Error('Session already finished');
    err.status = 409;
    throw err;
  }
  const count = await prisma.sessionExercise.count({ where: { sessionId } });
  return prisma.sessionExercise.create({
    data: {
      sessionId,
      exerciseId,
      order: count,
      sets: { create: [{ setNumber: 1 }] },
    },
    include: { exercise: true, sets: true },
  });
}

// "+ Add Set" on an exercise already in the session — appends the next set
// number, uncompleted, no weight/reps yet (the active-workout screen shows
// it with ghost values from the same previous-performance lookup as any
// other set).
export async function addSetToExerciseService(sessionId, sessionExerciseId, userId) {
  const session = await assertOwnsSession(sessionId, userId);
  if (session.endedAt) {
    const err = new Error('Session already finished');
    err.status = 409;
    throw err;
  }
  const sessionExercise = await prisma.sessionExercise.findUnique({
    where: { id: sessionExerciseId },
    include: { sets: true },
  });
  if (!sessionExercise || sessionExercise.sessionId !== sessionId) {
    const err = new Error('Exercise not found in this session');
    err.status = 404;
    throw err;
  }
  const nextSetNumber = sessionExercise.sets.length + 1;
  return prisma.workoutSet.create({
    data: { sessionExerciseId, setNumber: nextSetNumber },
  });
}

// Finishing is the trigger for the gamified layer (see the implementation
// plan's "Gamified layer" section) — fire-and-forget, never blocks the
// finish itself on challenge-service being up. coinsAwarded is this
// service's own idempotency guard, independent of challenge-service's
// ledger-level one, so a client retrying PATCH /sessions/:id after a
// timeout can never trigger a second credit attempt.
export async function finishSessionService(sessionId, userId) {
  const session = await assertOwnsSession(sessionId, userId);
  if (session.endedAt) {
    return prisma.workoutSession.findUnique({ where: { id: sessionId }, include: includeFull });
  }
  const updated = await prisma.workoutSession.update({
    where: { id: sessionId },
    data: { endedAt: new Date() },
    include: includeFull,
  });

  let gamification = { verified: false, credited: false };
  if (!session.coinsAwarded) {
    const exerciseNames = updated.exercises.map((e) => e.exercise.name).slice(0, 1);
    gamification = await notifyWorkoutFinished({
      userId,
      sessionId,
      description: `Verified workout${exerciseNames.length ? ` — ${exerciseNames[0]}` : ''}`,
      idempotencyKey: `workout-credit:${sessionId}`,
    });
    if (gamification.credited) {
      await prisma.workoutSession.update({ where: { id: sessionId }, data: { coinsAwarded: true } });
    }
  }

  return { ...updated, gamification };
}
