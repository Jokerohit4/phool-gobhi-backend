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

// Derives the user-local 'YYYY-MM-DD' this attendance/session belongs to.
// Fixed to Asia/Kolkata for now (the platform's only launched market) —
// see the BRD's edge-case note on travelling users for why this becomes a
// per-user tz lookup later, not a hardcoded offset forever.
function localDateIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Starting from a template pre-populates every SessionExercise/WorkoutSet
// row from its targets (targetSets rows per exercise, each carrying the
// previous-performance ghost values) — so the active-workout screen has
// something to render immediately, before the user taps anything.
// templateId omitted entirely means an "empty workout": zero exercises,
// added one at a time via POST /sessions/:id/exercises. `attendance` is the
// optional {bookingId, gymId} the client already knows about (e.g. starting
// a session from the gym-detail screen mid-visit) — usually left undefined
// and filled in later by getOrCreateDraftForAttendanceService instead.
export async function startSessionService(userId, templateId, attendance) {
  const attachData = attendance
    ? {
        bookingId: attendance.bookingId ?? null,
        gymId: attendance.gymId ?? null,
        localDate: localDateIST(attendance.attendedAt ?? new Date()),
      }
    : {};
  if (!templateId) {
    return prisma.workoutSession.create({ data: { userId, ...attachData }, include: includeFull });
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
      ...attachData,
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

// Called from health-service's /internal/attendance-events, itself fired by
// booking-service's emitAttendanceSignals on every verified booking
// check-in (see notifyHealthService.recordAttendanceForWorkout on the
// booking-service side — NOT yet wired to emitMemberAttendanceSignals, the
// attendance-SaaS member-checkin path, since that flow isn't live). Turns
// "log a session" into "confirm a session" — the draft already carries
// booking/gym/day context before the user opens the app. Idempotent on
// bookingId (a retried/duplicate attendance event for the same booking must
// never create a second draft); the no-bookingId fallback keys off
// (userId, gymId, localDate) instead, since that's the only natural key
// available once a member-checkin path is wired here later — a real second
// visit to the same gym on the same day is the one case that dedupes away,
// judged an acceptable v0 tradeoff over a separate idempotency table for a
// still-unlaunched path.
export async function getOrCreateDraftForAttendanceService({ userId, bookingId, gymId, attendedAt }) {
  const localDate = localDateIST(attendedAt);
  const existing = await prisma.workoutSession.findFirst({
    where: bookingId
      ? { userId, bookingId }
      : { userId, gymId, localDate, bookingId: null },
  });
  if (existing) return existing;
  return prisma.workoutSession.create({
    data: { userId, bookingId: bookingId ?? null, gymId: gymId ?? null, localDate },
  });
}

// Powers the Home "log today's session" card: the one thing a client needs
// to know is "is there a session for today, and is it still unconfirmed
// (type null)?" — one query instead of listing everything and filtering
// client-side. Most-recently-started wins on the rare two-gyms-same-day
// case, matching the BRD's "streak counts one flame" call for that edge
// case (PRD §10.1) — the other same-day session is still reachable via the
// normal list/detail endpoints, just not the one Home highlights.
export async function getTodaySessionService(userId) {
  const today = localDateIST(new Date());
  const session = await prisma.workoutSession.findFirst({
    where: { userId, localDate: today },
    include: includeFull,
    orderBy: { startedAt: 'desc' },
  });
  return session ? attachPreviousPerformance(session) : null;
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
export async function finishSessionService(sessionId, userId, { type, rpe } = {}) {
  const session = await assertOwnsSession(sessionId, userId);
  if (session.endedAt) {
    return prisma.workoutSession.findUnique({ where: { id: sessionId }, include: includeFull });
  }
  const updated = await prisma.workoutSession.update({
    where: { id: sessionId },
    data: {
      endedAt: new Date(),
      ...(type !== undefined ? { type } : {}),
      ...(rpe !== undefined ? { rpe } : {}),
      // A session finished with no bookingId yet (started before any
      // attendance draft existed, e.g. offline) still gets a localDate so
      // it's never excluded from day-keyed charts later.
      ...(session.localDate ? {} : { localDate: localDateIST(new Date()) }),
    },
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
