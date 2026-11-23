import test from 'node:test';
import assert from 'node:assert/strict';

// Batch per-day activity for company leaderboards. What matters: consent is
// respected for workouts, only day keys / step counts leave the service, and
// the window and batch size are bounded.

let orgActivityForUsers; let validateWindow;
test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class {} } });
  ({ orgActivityForUsers, validateWindow } = await import('../services/orgActivityService.js'));
});

const done = (userId, endedAt, over = {}) => ({
  userId, startedAt: new Date(new Date(endedAt).getTime() - 40 * 60000), endedAt: new Date(endedAt), type: 'strength',
  activeSeconds: 2400, pausedSeconds: 0, exercises: [{ sets: [{ completed: true }] }], ...over,
});

function fakePrisma({ consents = [], sessions = [], steps = [] } = {}) {
  const seen = {};
  return {
    seen,
    coachConsent: { findMany: async (a) => { seen.consent = a; return consents; } },
    workoutSession: { findMany: async (a) => { seen.sessions = a; return sessions; } },
    dailyActivityMetric: { findMany: async (a) => { seen.steps = a; return steps; } },
  };
}

test('workouts count only for people with a live basic consent; steps always come through', async () => {
  const prisma = fakePrisma({
    consents: [{ userId: 1, scopes: ['basic'] }, { userId: 3, scopes: ['supplements'] }],
    sessions: [done(1, '2026-12-03T10:00:00Z'), done(2, '2026-12-03T10:00:00Z'), done(3, '2026-12-03T10:00:00Z')],
    steps: [{ userId: 2, date: '2026-12-03', steps: 7000 }],
  });
  const out = await orgActivityForUsers(prisma, { userIds: [1, 2, 3], from: '2026-12-01', to: '2026-12-10' });
  assert.deepEqual(out[1].workoutDays, ['2026-12-03']);
  assert.deepEqual(out[2].workoutDays, [], 'no consent, no workout read');
  assert.deepEqual(out[3].workoutDays, [], 'a consent without the basic scope does not count');
  assert.deepEqual(out[2].stepsByDay, { '2026-12-03': 7000 });
});

test('revoked consents are excluded at the query, and the query is scoped to the asked-for ids and window', async () => {
  const prisma = fakePrisma();
  await orgActivityForUsers(prisma, { userIds: [5, 6], from: '2026-12-01', to: '2026-12-10' });
  assert.equal(prisma.seen.consent.where.revokedAt, null);
  assert.deepEqual(prisma.seen.consent.where.userId, { in: [5, 6] });
  assert.deepEqual(prisma.seen.sessions.where.userId, { in: [5, 6] });
  assert.equal(prisma.seen.sessions.where.startedAt.gte.toISOString(), '2026-11-30T18:30:00.000Z');
  assert.deepEqual(prisma.seen.steps.where.date, { gte: '2026-12-01', lte: '2026-12-10' });
});

test('short sessions and sessions with no completed sets do not make a day', async () => {
  const prisma = fakePrisma({
    consents: [{ userId: 1, scopes: ['basic'] }],
    sessions: [
      done(1, '2026-12-03T10:00:00Z', { activeSeconds: 300 }),
      done(1, '2026-12-04T10:00:00Z', { exercises: [{ sets: [{ completed: false }] }] }),
      done(1, '2026-12-05T10:00:00Z'),
    ],
  });
  const out = await orgActivityForUsers(prisma, { userIds: [1], from: '2026-12-01', to: '2026-12-10' });
  assert.deepEqual(out[1].workoutDays, ['2026-12-05']);
});

test('the window is validated', () => {
  assert.throws(() => validateWindow('2026-12-10', '2026-12-01'), (e) => e.status === 400);
  assert.throws(() => validateWindow('nope', '2026-12-01'), (e) => e.status === 400);
  assert.throws(() => validateWindow('2020-01-01', '2026-12-01'), (e) => e.status === 400);
  assert.doesNotThrow(() => validateWindow('2026-12-01', '2026-12-01'));
});

test('the HTTP handler caps the batch and requires ids', async (t) => {
  let handler;
  t.mock.module(new URL('../services/orgActivityService.js', import.meta.url).href, {
    exports: { orgActivityForUsers: async () => ({}), validateWindow },
  });
  ({ getOrgActivityInternal: handler } = await import('../controllers/challengeActivityController.js'));
  const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  let r = res(); await handler({ query: {} }, r); assert.equal(r.code, 400);
  r = res(); await handler({ query: { ids: Array.from({ length: 501 }, (_, i) => i + 1).join(','), from: '2026-12-01', to: '2026-12-02' } }, r);
  assert.equal(r.code, 400);
  r = res(); await handler({ query: { ids: '1,2', from: '2026-12-01', to: '2026-12-02' } }, r);
  assert.equal(r.code, 200);
});
