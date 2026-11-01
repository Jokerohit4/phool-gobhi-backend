import { isoDayIST } from '../utils/sessionDay.js';
import { recordRoutineWorkout } from './routineJourneyService.js';
import prisma from '../db/prisma.js';
import { computeProgression } from './progressionService.js';
import { randomInt } from 'node:crypto';
import { notifyWorkoutFinished } from '../utils/notifyChallengeService.js';
import { creditWorkoutPhotoCoins } from '../utils/notifyWorkoutPhoto.js';
import { emitJourneyInvalidate } from '../utils/journeyCacheBus.js';
import { pageArgs, finishPage } from '../utils/pagination.js';
import * as photoStorage from './ledger/foodPhotoStorage.js';
import { loadSuggestedRest } from './restSuggestionService.js';
import { latestBiometricRows } from './biometricLatest.js';

const MAX_SECONDS = 86400;

// Optional client-reported duration: a non-negative integer up to a day, else
// ignored (undefined) - bad telemetry must never fail finishing a workout.
export function sanitizeSeconds(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SECONDS) return undefined;
  return n;
}

// Adds `photoUrl` (a freshly minted short-lived signed URL; never persisted,
// the bucket is private) and drops the internal storage path. Best-effort: a
// signing failure yields photoUrl null rather than failing the read.
async function withPhotoUrl(session, { suggestRest = true } = {}) {
  if (!session) return session;
  const { photoStoragePath, ...rest } = session;
  // Personalised rest per exercise (see restSuggestionService). Best-effort:
  // a failure just means no suggestions. The routine's own `restSeconds` on
  // each exercise is left untouched.
  if (Array.isArray(rest.exercises) && rest.exercises.length) {
    let suggestions = new Map();
    // History lists skip the lookup (a suggestion is meaningless on a past
    // session and would be one query per row): fields are present, null.
    try {
      if (suggestRest) suggestions = await loadSuggestedRest(session.userId, rest.exercises.map((e) => e.exerciseId), { excludeSessionId: session.id });
    } catch (err) { console.error('[restSuggestion] failed:', err?.message); }
    rest.exercises = rest.exercises.map((e) => {
      const sug = suggestions.get(e.exerciseId);
      return { ...e, suggestedRestSeconds: sug ? sug.seconds : null, restSuggestionSource: sug ? 'history' : null };
    });
  }
  let photoUrl = null;
  if (photoStoragePath) {
    try { photoUrl = await photoStorage.signedPhotoUrl(photoStoragePath); }
    catch (err) { console.error('[workoutPhoto] sign failed:', err?.message); }
  }
  return { ...rest, photoUrl };
}

// Applies double progression to the routine a finished session was started
// from, and returns what changed so the app can say so. Best-effort by the
// caller: a failure here must never fail finishing the workout.
async function applyTemplateProgression(finished, templateId) {
  const owner = await prisma.workoutTemplate.findUnique({ where: { id: templateId } });
  if (!owner || owner.userId !== finished.userId) return [];
  const rows = await prisma.templateExercise.findMany({ where: { templateId } });
  const changes = [];
  for (const te of rows) {
    if (!te.repMax || (te.phase && te.phase !== 'main')) continue;
    const logged = finished.exercises.find((e) => e.exerciseId === te.exerciseId && (e.phase ?? 'main') === 'main');
    const next = computeProgression(te, logged?.sets);
    if (!next) continue;
    await prisma.templateExercise.update({
      where: { id: te.id },
      data: {
        targetReps: next.targetReps,
        ...(next.weightKg != null ? { targetWeightKg: next.weightKg } : {}),
      },
    });
    if (next.kind !== 'baseline') {
      changes.push({
        exerciseId: te.exerciseId,
        name: logged?.exercise?.name ?? null,
        kind: next.kind,
        fromWeightKg: te.targetWeightKg ?? null,
        toWeightKg: next.weightKg,
        targetReps: next.targetReps,
      });
    }
  }
  return changes;
}

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
// app per the UI/UX section's research. "Most recent" is decided
// in the query (session.startedAt desc, id desc, take 1) - the same row the old
// read-everything-then-sort-in-JS picked, minus loading the exercise's whole
// history. Only identical startedAt ties could differ, and those were arbitrary.
async function attachPreviousPerformance(session) {
  const exercisesWithPrevious = await Promise.all(
    session.exercises.map(async (se) => {
      const priorSessions = await prisma.sessionExercise.findMany({
        where: {
          exerciseId: se.exerciseId,
          phase: se.phase ?? 'main',
          session: { userId: session.userId, startedAt: { lt: session.startedAt } },
        },
        include: { sets: { where: { completed: true } }, session: { select: { startedAt: true } } },
        orderBy: [{ session: { startedAt: 'desc' } }, { id: 'desc' }],
        take: 1,
      });
      const mostRecent = priorSessions[0];
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
// Fixed to the platform timezone for now (the platform's only launched market) —
// see the BRD's edge-case note on travelling users for why this becomes a
// per-user tz lookup later, not a hardcoded offset forever.
function localDateIST(date) {
  return isoDayIST(new Date(date));
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
// FR-23. `clientRef` is a client-generated id for ONE logical save. A log
// queued offline and replayed on reconnect sends the same ref, so the
// retry returns the session it already created instead of a duplicate.
//
// Checked before insert AND caught on the unique violation after it: two
// replays racing each other both pass the check, and only the loser sees
// P2002. Without the second half, a double-tap on a flaky connection still
// produces two sessions - the exact failure the column exists to prevent.
export async function startSessionService(userId, templateId, attendance, clientRef) {
  // localDate is stamped on EVERY start, not just attendance-backed ones.
  // It is the only way getTodaySessionService can ever see a session, and an
  // abandoned workout (started, never finished) has no finish event to fall
  // back on — without this the Home "resume" card can never find one and the
  // leave dialog's "you can resume from Workouts later" is a lie.
  const attachData = {
    localDate: localDateIST(attendance?.attendedAt ?? new Date()),
    ...(attendance
      ? { bookingId: attendance.bookingId ?? null, gymId: attendance.gymId ?? null }
      : {}),
  };

  if (clientRef) {
    const existing = await prisma.workoutSession.findUnique({
      where: { clientRef },
      include: includeFull,
    });
    // Scoped to the caller: a ref is client-generated, so treating someone
    // else's as "already done" would hand them another user's session.
    if (existing && existing.userId === userId) return withPhotoUrl(existing);
    if (existing) {
      const err = new Error('clientRef already used');
      err.status = 409;
      throw err;
    }
  }

  const createData = { userId, ...attachData, ...(clientRef ? { clientRef } : {}) };

  try {
    return await withPhotoUrl(await createSessionRow(createData, templateId, userId));
  } catch (err) {
    if (clientRef && err?.code === 'P2002') {
      const raced = await prisma.workoutSession.findUnique({
        where: { clientRef },
        include: includeFull,
      });
      if (raced && raced.userId === userId) return withPhotoUrl(raced);
    }
    throw err;
  }
}

async function createSessionRow(createData, templateId, userId) {
  if (!templateId) {
    return prisma.workoutSession.create({ data: createData, include: includeFull });
  }
  const template = await prisma.workoutTemplate.findUnique({
    where: { id: templateId },
    include: { exercises: { orderBy: { order: 'asc' } } },
  });
  if (!template || (template.userId !== userId && !template.isSystem)) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  const session = await prisma.workoutSession.create({
    data: {
      ...createData,
      templateId,
      exercises: {
        create: template.exercises.map((te) => ({
          exerciseId: te.exerciseId,
          order: te.order,
          phase: te.phase ?? 'main',
          instructions: te.instructions ?? null,
          restSeconds: te.restSeconds ?? null,
          supersetGroup: te.supersetGroup,
          sets: {
            // A routine with a stored weight / rep range pre-fills every set
            // with today's goal; the checkmark still decides what was done.
            create: Array.from({ length: te.targetSets }, (_, i) => ({
              setNumber: i + 1,
              ...(te.targetWeightKg != null ? { weightKg: te.targetWeightKg } : {}),
              ...(te.targetReps != null ? { reps: te.targetReps } : {}),
              ...(te.targetDurationSeconds != null ? { durationSeconds: te.targetDurationSeconds } : {}),
            })),
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
//
// Attendance provenance (attendanceMethod + attendedAt) is stamped here and
// nowhere else. Two rules:
//   - An unrecognised method is stored as null, not as whatever string came
//     in. The insurer-grade score maps each known value to an evidence level,
//     and a value it has never seen must land in "unknown", not be guessed at.
//   - On an EXISTING session provenance is only filled in when still null,
//     never overwritten. The client may have started the session with this
//     bookingId before the check-in event arrived (that is the first branch of
//     the lookup), and a retried event must not be able to change how a visit
//     was proven after the fact. First proof wins.
export const ATTENDANCE_METHODS = new Set(['qr_scan', 'qr_geofence_self', 'manual_verify', 'manual_override']);

export async function getOrCreateDraftForAttendanceService({ userId, bookingId, gymId, attendedAt, attendanceMethod = null }) {
  const localDate = localDateIST(attendedAt);
  const method = ATTENDANCE_METHODS.has(attendanceMethod) ? attendanceMethod : null;
  const at = attendedAt ? new Date(attendedAt) : null;
  const provenance = method ? { attendanceMethod: method, attendedAt: at } : {};
  const existing = await prisma.workoutSession.findFirst({
    where: bookingId
      ? { userId, bookingId }
      : { userId, gymId, localDate, bookingId: null },
  });
  if (existing) {
    if (method && existing.attendanceMethod == null) {
      return prisma.workoutSession.update({ where: { id: existing.id }, data: provenance });
    }
    return existing;
  }
  return prisma.workoutSession.create({
    data: { userId, bookingId: bookingId ?? null, gymId: gymId ?? null, localDate, ...provenance },
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
  return session ? withPhotoUrl(await attachPreviousPerformance(session)) : null;
}

export async function listSessionsService(userId) {
  const rows = await prisma.workoutSession.findMany({
    where: { userId },
    include: includeFull,
    orderBy: { startedAt: 'desc' },
  });
  return Promise.all(rows.map((r) => withPhotoUrl(r, { suggestRest: false })));
}

// Cursor-paginated variant behind GET /sessions. Same order as listSessionsService
// (startedAt desc) with id desc as a tiebreaker so equal timestamps never
// duplicate/drop across a page boundary. Same item shape (includeFull).
// Returns { items, meta } — see utils/pagination.js.
export async function listSessionsPageService(userId, { limit, cursor } = {}) {
  const rows = await prisma.workoutSession.findMany({
    where: { userId },
    include: includeFull,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    ...pageArgs({ limit, cursor }),
  });
  const page = finishPage(rows, limit);
  return { ...page, items: await Promise.all(page.items.map((r) => withPhotoUrl(r, { suggestRest: false }))) };
}

export async function getSessionDetailService(sessionId, userId) {
  await assertOwnsSession(sessionId, userId);
  const session = await prisma.workoutSession.findUnique({ where: { id: sessionId }, include: includeFull });
  return withPhotoUrl(await attachPreviousPerformance(session));
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
  const restSeconds = sanitizeSeconds(body?.restSeconds);
  return prisma.workoutSet.update({
    where: { id: setId },
    data: {
      ...(weightKg !== undefined ? { weightKg } : {}),
      ...(reps !== undefined ? { reps } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(distanceMeters !== undefined ? { distanceMeters } : {}),
      ...(completed !== undefined ? { completed } : {}),
      ...(restSeconds !== undefined ? { restSeconds } : {}),
      // Stamped when the checkmark flips on, cleared when it flips off.
      ...(completed === true && !set.completed ? { completedAt: new Date() } : {}),
      ...(completed === false ? { completedAt: null } : {}),
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
export async function finishSessionService(sessionId, userId, { type, rpe, activeSeconds, pausedSeconds } = {}) {
  const session = await assertOwnsSession(sessionId, userId);
  if (session.endedAt) {
    return withPhotoUrl(await prisma.workoutSession.findUnique({ where: { id: sessionId }, include: includeFull }));
  }
  const active = sanitizeSeconds(activeSeconds);
  const paused = sanitizeSeconds(pausedSeconds);
  // Body weight at the time of the workout: newest weight biometric, null if
  // none. Best-effort - never blocks finishing.
  let bodyWeightKg;
  try {
    const rows = await latestBiometricRows(prisma, userId);
    const w = rows.find((r) => r.metric === 'weight');
    bodyWeightKg = w ? Number(w.value) : null;
    if (!Number.isFinite(bodyWeightKg)) bodyWeightKg = null;
  } catch (err) {
    console.error('[workout] body weight snapshot failed:', err?.message);
    bodyWeightKg = null;
  }
  const updated = await prisma.workoutSession.update({
    where: { id: sessionId },
    data: {
      endedAt: new Date(),
      ...(type !== undefined ? { type } : {}),
      ...(rpe !== undefined ? { rpe } : {}),
      ...(active !== undefined ? { activeSeconds: active } : {}),
      ...(paused !== undefined ? { pausedSeconds: paused } : {}),
      bodyWeightKg,
      // A session finished with no bookingId yet (started before any
      // attendance draft existed, e.g. offline) still gets a localDate so
      // it's never excluded from day-keyed charts later.
      ...(session.localDate ? {} : { localDate: localDateIST(new Date()) }),
    },
    include: includeFull,
  });
  // A finished session can add a showed-up day: drop the cached journey so the
  // next Home read reflects it instead of waiting out the TTL.
  emitJourneyInvalidate(userId);

  let routinePolicy;
  try { routinePolicy = await recordRoutineWorkout(prisma, updated); }
  catch (error) { console.error('[routine] workout progress unavailable:', error.message); routinePolicy = { starterAmount: 0, verifiedAmount: 0 }; }
  let gamification = { verified: false, credited: false };
  // Empty sessions never feed the gamified layer (audit 2026-10-08, P1).
  // Dismissing the quick-log sheet finishes a session with zero completed
  // sets, and that finish used to verify+credit like a real workout — with
  // challenge-service's per-day key it would only cost the user that day's
  // coins, but it would still record a "verified workout" they never did, so
  // the gate belongs here where the sets live.
  const completedSets = updated.exercises.reduce(
    (total, ex) => total + ex.sets.filter((s) => s.completed).length,
    0,
  );
  // Legacy credits require a completed set. Routine credits also allow a
  // qualifying timed session of at least ten minutes, checked server-side.
  if ((completedSets > 0 || (routinePolicy?.verifiedAmount ?? 0) > 0) && (!session.coinsAwarded || routinePolicy)) {
    const exerciseNames = updated.exercises.map((e) => e.exercise.name).slice(0, 1);
    gamification = await notifyWorkoutFinished({
      userId,
      sessionId,
      description: `${routinePolicy ? 'Workout' : 'Verified workout'}${exerciseNames.length ? ` — ${exerciseNames[0]}` : ''}`,
      idempotencyKey: `workout-credit:${sessionId}`,
      routinePolicy,
    });
    if (gamification.credited) {
      await prisma.workoutSession.update({ where: { id: sessionId }, data: { coinsAwarded: true } });
    }
  }

  let progression = [];
  if (session.templateId) {
    try {
      progression = await applyTemplateProgression(updated, session.templateId);
    } catch (err) {
      console.error('[progression] failed for session', sessionId, err);
    }
  }

  return { ...(await withPhotoUrl(updated)), gamification, progression };
}

// POST /sessions/:id/photo. Stores the photo on the (finished) session and pays
// a one-time random 1-5 coin reward, rolled server-side with a CSPRNG.
//
// The reward is paid at most once per session: photoRewardCoins is persisted
// only AFTER challenge-service accepts the credit, and the credit key
// (`workout-photo-<sessionId>`) is stable, so a failed credit leaves the field
// null and a retry can pay - while a replaced photo on an already-rewarded
// session never rolls or pays again.
export async function uploadSessionPhotoService(sessionId, userId, { buffer, mimeType }, { rng = () => randomInt(1, 6), credit = creditWorkoutPhotoCoins } = {}) {
  const session = await assertOwnsSession(sessionId, userId);
  if (!session.endedAt) {
    const err = new Error('Finish the workout before adding a photo');
    err.status = 409;
    err.code = 'SESSION_NOT_FINISHED';
    throw err;
  }
  const path = await photoStorage.saveWorkoutPhoto({ buffer, mimeType, userId });
  if (!path) {
    const err = new Error('photo is required');
    err.status = 400;
    throw err;
  }
  await prisma.workoutSession.update({
    where: { id: sessionId },
    data: { photoStoragePath: path, photoUploadedAt: new Date() },
  });
  // Replaced photo: reclaim the old object (best-effort, never throws).
  if (session.photoStoragePath) await photoStorage.deletePhotos([session.photoStoragePath]);

  let reward = { coins: session.photoRewardCoins ?? 0, credited: false };
  if (session.photoRewardCoins == null) {
    const coins = rng();
    const ok = await credit({ userId, sessionId, amount: coins });
    if (ok) {
      await prisma.workoutSession.update({ where: { id: sessionId }, data: { photoRewardCoins: coins } });
      reward = { coins, credited: true };
    } else {
      reward = { coins: 0, credited: false };
    }
  }
  const data = await getSessionDetailService(sessionId, userId);
  return { data, reward };
}
