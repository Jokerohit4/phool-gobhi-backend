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
}

let getOrCreateDraftForAttendanceService, getTodaySessionService;

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
    exports: { notifyWorkoutFinished: async () => ({ verified: false, credited: false }) },
  });

  ({ getOrCreateDraftForAttendanceService, getTodaySessionService } = await import(
    '../services/workoutSessionService.js'
  ));
  assert.equal(typeof getOrCreateDraftForAttendanceService, 'function');
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
