// Covers the two pieces of the Fitness+ session-attach delta (2026-09-08)
// that are actually risky to get wrong pre-launch: the auto-draft
// idempotency (a retried/duplicate attendance event must never create a
// second session for the same booking) and the Home "today" lookup. Mirrors
// booking-service's test/emitAttendanceSignals.test.js mocking convention.
// Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let workoutSessions = [];
let nextId = 1;

function resetFakes() {
  workoutSessions = [];
  nextId = 1;
  notifyCalls = [];
}

let getOrCreateDraftForAttendanceService, getTodaySessionService, startSessionService, finishSessionService;
let notifyCalls = [];

test('setup: mock dependencies once, import workoutSessionService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = {
            // Generic partial-match on whatever keys the real query passes —
            // both getOrCreateDraftForAttendanceService's narrower where
            // (bookingId, or gymId+localDate+bookingId:null) and
            // getTodaySessionService's broader one (userId+localDate only)
            // need to work against the same fake. Last match wins, which
            // approximates the real `orderBy: startedAt desc` since test
            // sessions are created in increasing id/time order.
            findFirst: async ({ where }) => {
              const matches = workoutSessions.filter((s) =>
                Object.entries(where).every(([k, v]) => s[k] === v),
              );
              return matches[matches.length - 1] || null;
            },
            // assertOwnsSession's lookup (finishSessionService and friends).
            findUnique: async ({ where }) => workoutSessions.find((s) => s.id === where.id) ?? null,
            create: async ({ data }) => {
              const session = { id: nextId++, exercises: [], ...data };
              workoutSessions.push(session);
              return session;
            },
            update: async ({ where, data }) => {
              const session = workoutSessions.find((s) => s.id === where.id);
              Object.assign(session, data);
              return session;
            },
          };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: {
      notifyWorkoutFinished: async (args) => {
        notifyCalls.push(args);
        return { verified: true, credited: true, amount: 15 };
      },
    },
  });

  ({ getOrCreateDraftForAttendanceService, getTodaySessionService, startSessionService, finishSessionService } = await import(
    '../services/workoutSessionService.js'
  ));
  assert.equal(typeof getOrCreateDraftForAttendanceService, 'function');
  assert.equal(typeof finishSessionService, 'function');
});

test('getOrCreateDraftForAttendanceService: no existing draft -> creates one attached to the booking', async () => {
  resetFakes();
  const session = await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 100, gymId: 9, attendedAt: '2026-09-08T13:00:00.000Z',
  });
  assert.equal(workoutSessions.length, 1);
  assert.equal(session.bookingId, 100);
  assert.equal(session.gymId, 9);
  assert.equal(session.localDate, '2026-09-08');
});

test('getOrCreateDraftForAttendanceService: retried attendance event for the same booking -> returns the existing draft, no duplicate', async () => {
  resetFakes();
  const first = await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 100, gymId: 9, attendedAt: '2026-09-08T13:00:00.000Z',
  });
  const second = await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 100, gymId: 9, attendedAt: '2026-09-08T13:05:00.000Z',
  });
  assert.equal(workoutSessions.length, 1, 'a duplicate attendance event for the same booking must not create a second session');
  assert.equal(second.id, first.id);
});

test('getOrCreateDraftForAttendanceService: no bookingId -> dedupes on (userId, gymId, localDate) instead', async () => {
  resetFakes();
  const first = await getOrCreateDraftForAttendanceService({ userId: 2, gymId: 9, attendedAt: '2026-09-08T08:00:00.000Z' });
  const second = await getOrCreateDraftForAttendanceService({ userId: 2, gymId: 9, attendedAt: '2026-09-08T18:00:00.000Z' });
  assert.equal(workoutSessions.length, 1);
  assert.equal(second.id, first.id);
});

test('getTodaySessionService: no session for today -> null', async () => {
  resetFakes();
  const session = await getTodaySessionService(1);
  assert.equal(session, null);
});

test('getTodaySessionService: a session exists for today -> returns it', async () => {
  resetFakes();
  await getOrCreateDraftForAttendanceService({ userId: 1, bookingId: 100, gymId: 9, attendedAt: new Date().toISOString() });
  const session = await getTodaySessionService(1);
  assert.ok(session);
  assert.equal(session.bookingId, 100);
});

// ---- Attendance provenance (insurer-grade score prerequisite) -------------

test('provenance: a known attendanceMethod is stamped on the new draft with the gym attendedAt', async () => {
  resetFakes();
  const session = await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 300, gymId: 9, attendedAt: '2026-09-30T04:00:00.000Z', attendanceMethod: 'qr_scan',
  });
  assert.equal(session.attendanceMethod, 'qr_scan');
  assert.equal(session.attendedAt.toISOString(), '2026-09-30T04:00:00.000Z');
});

test('provenance: an unknown method is dropped to null (unknown provenance), never stored as-is', async () => {
  resetFakes();
  const session = await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 301, gymId: 9, attendedAt: '2026-09-30T04:00:00.000Z', attendanceMethod: 'teleported',
  });
  assert.equal(session.attendanceMethod ?? null, null);
  assert.equal(session.attendedAt ?? null, null, 'no method means no provenance at all, not a half-stamp');
});

test('provenance: a client-started session with the bookingId gets provenance filled in by the later event', async () => {
  resetFakes();
  workoutSessions.push({ id: nextId++, userId: 1, bookingId: 302, gymId: 9, localDate: '2026-09-30', attendanceMethod: null });
  const session = await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 302, gymId: 9, attendedAt: '2026-09-30T04:00:00.000Z', attendanceMethod: 'qr_geofence_self',
  });
  assert.equal(workoutSessions.length, 1);
  assert.equal(session.attendanceMethod, 'qr_geofence_self');
});

test('provenance: first proof wins - a retried event cannot change how a visit was proven', async () => {
  resetFakes();
  await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 303, gymId: 9, attendedAt: '2026-09-30T04:00:00.000Z', attendanceMethod: 'manual_override',
  });
  const again = await getOrCreateDraftForAttendanceService({
    userId: 1, bookingId: 303, gymId: 9, attendedAt: '2026-09-30T05:00:00.000Z', attendanceMethod: 'qr_scan',
  });
  assert.equal(again.attendanceMethod, 'manual_override', 'an override must never be upgraded to a scan by a replay');
});

// ---- W2 (2026-10-08): every start is day-keyed so an abandoned workout can
// be found again. Without a localDate on start, GET /sessions/today can only
// ever see attendance-backed or already-finished sessions, and the Home
// "resume" card has nothing to resume.

const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('startSessionService: a session with no attendance still carries today\'s localDate', async () => {
  resetFakes();
  const session = await startSessionService(1, null, undefined, undefined);
  assert.equal(session.localDate, todayIST(), 'localDate is stamped on start, not only on finish/attendance');
  assert.equal(session.bookingId ?? null, null);
  assert.equal(session.gymId ?? null, null);
  assert.equal(session.endedAt ?? null, null, 'the session is still in progress');
});

test('startSessionService: an attendance-backed start keeps its booking/gym and keys off attendedAt', async () => {
  resetFakes();
  const session = await startSessionService(
    1, null,
    { bookingId: 100, gymId: 9, attendedAt: '2026-09-08T13:00:00.000Z' },
    undefined,
  );
  assert.equal(session.localDate, '2026-09-08');
  assert.equal(session.bookingId, 100);
  assert.equal(session.gymId, 9);
});

test('getTodaySessionService: an abandoned (unfinished) client-started session is resumable', async () => {
  resetFakes();
  const started = await startSessionService(2, null, undefined, undefined);
  assert.equal(started.endedAt ?? null, null);
  const today = await getTodaySessionService(2);
  assert.ok(today, '/sessions/today must return an unfinished session so the client can resume it');
  assert.equal(today.id, started.id);
});

// ---- finish -> gamified layer ---------------------------------------------
// The 2026-10-08 audit's P1 "empty workouts count fully": dismissing the
// quick-log sheet finishes a session with zero completed sets, and that used
// to reach challenge-service like a real workout. The gate lives here,
// because health-service is the only service that can see the sets.

function seedSession(userId, exercises) {
  const session = {
    id: nextId++, userId, bookingId: null, gymId: null,
    localDate: todayIST(), startedAt: new Date(), endedAt: null,
    coinsAwarded: false, exercises,
  };
  workoutSessions.push(session);
  return session;
}

test('finishSessionService: a session with no completed set is finished but never reaches the gamified layer', async () => {
  resetFakes();
  const session = seedSession(1, [
    { exercise: { name: 'Squat' }, sets: [{ setNumber: 1, completed: false }] },
  ]);
  const finished = await finishSessionService(session.id, 1, {});

  assert.ok(finished.endedAt, 'finishing still works — only the reward is skipped');
  assert.deepEqual(finished.gamification, { verified: false, credited: false });
  assert.equal(notifyCalls.length, 0, 'notifyWorkoutFinished must not be called for an empty session');
  assert.equal(workoutSessions[0].coinsAwarded, false);
});

test('finishSessionService: a session with zero exercises is finished but never reaches the gamified layer', async () => {
  resetFakes();
  const session = seedSession(1, []);
  const finished = await finishSessionService(session.id, 1, {});
  assert.ok(finished.endedAt);
  assert.deepEqual(finished.gamification, { verified: false, credited: false });
  assert.equal(notifyCalls.length, 0);
});

test('finishSessionService: one completed set pays, keyed on the session id', async () => {
  resetFakes();
  const session = seedSession(1, [
    { exercise: { name: 'Bench Press' }, sets: [{ setNumber: 1, completed: true }] },
    { exercise: { name: 'Row' }, sets: [{ setNumber: 1, completed: false }] },
  ]);
  const finished = await finishSessionService(session.id, 1, { rpe: 8 });

  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].idempotencyKey, `workout-credit:${session.id}`);
  assert.equal(notifyCalls[0].description, 'Verified workout — Bench Press');
  assert.deepEqual(finished.gamification, { verified: true, credited: true, amount: 15 });
  assert.equal(workoutSessions[0].coinsAwarded, true, 'coinsAwarded is this service\'s own replay guard');
});

test('finishSessionService: finishing an already-finished session is a no-op for the reward too', async () => {
  resetFakes();
  const session = seedSession(1, [
    { exercise: { name: 'Bench Press' }, sets: [{ setNumber: 1, completed: true }] },
  ]);
  await finishSessionService(session.id, 1, {});
  const again = await finishSessionService(session.id, 1, {});
  assert.equal(notifyCalls.length, 1, 'a client retry after a timeout must not trigger a second credit attempt');
  assert.equal(again.endedAt.getTime(), workoutSessions[0].endedAt.getTime());
});
