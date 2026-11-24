import { test } from 'node:test';
import assert from 'node:assert/strict';

// Who is counted, who only appears as a number, and what staff get as
// follow-up lists. In-memory fakes for the database and the other services.

let org; let attendance = []; let users = {}; let activity = { data: {}, complete: true }; let lastActivityWindow = null;
let svc;

test('setup', async (t) => {
  t.mock.module('../db/prisma.js', {
    defaultExport: {
      organization: { findUnique: async () => org },
      attendanceEventLog: { findMany: async ({ where }) => attendance.filter((r) => where.userId.in.includes(r.userId)) },
    },
  });
  t.mock.module('../services/orgDirectory.js', {
    namedExports: {
      normalizePhone: (p) => p, lookupUserIdByPhone: async () => null,
      fetchUsersByIds: async (ids) => Object.fromEntries(ids.filter((i) => users[i]).map((i) => [i, users[i]])),
      fetchOrgActivity: async (ids, from, to) => { lastActivityWindow = { from, to, ids: [...ids].sort() }; return activity; },
      fetchOrgConsent: async () => ({ data: {}, complete: true }),
    },
  });
  svc = await import('../services/orgDashboardService.js');
});

const NOW = new Date('2026-12-14T08:00:00Z'); // 13:30 IST on 14 Dec
const member = (id, over) => ({ id, orgId: 1, status: 'active', userId: null, phone: `98765432${String(id).padStart(2, '0')}`, displayName: null, teamId: null, addedAt: new Date('2026-12-01T00:00:00Z'), ...over });

function reset(over = {}) {
  attendance = []; lastActivityWindow = null;
  users = {
    101: { id: 101, name: 'Asha Rao', phone: '9876543201', leaderboardOptIn: true },
    102: { id: 102, name: 'Bala Kumar', phone: '9876543202', leaderboardOptIn: true },
    103: { id: 103, name: 'Chitra Menon', phone: '9876543203', leaderboardOptIn: false },
  };
  activity = { complete: true, data: {
    101: { consented: true, workoutDays: ['2026-12-10', '2026-12-12'], stepsByDay: { '2026-12-10': 6000 } },
    102: { consented: false, workoutDays: [], stepsByDay: {} },
    103: { consented: true, workoutDays: ['2026-12-11'], stepsByDay: {} }, // would be counted if opt-out were ignored
  } };
  org = {
    id: 1, name: 'Acme', slug: 'acme', status: 'active', startsAt: new Date('2026-12-01T00:00:00Z'), expiresAt: null,
    convertedAt: null, createdAt: new Date('2026-12-01T00:00:00Z'),
    teams: [{ id: 7, name: 'Sales' }],
    leaderboards: [],
    members: [
      member(1, { userId: 101, teamId: 7 }), member(2, { userId: 102, teamId: 7 }), member(3, { userId: 103 }),
      member(4, { status: 'invited', phone: '9000000004', displayName: 'Dev' }),
    ],
    ...over,
  };
}

test('only linked, opted-in, consented people are counted; the rest are numbers in the funnel', async () => {
  reset();
  attendance = [{ userId: 101, attendedAt: new Date('2026-12-13T03:00:00Z') }];
  const d = await svc.getOrgDashboard(1, { days: 30 }, NOW);
  assert.deepEqual(d.stats.counts, { added: 4, invited: 1, joined: 3, optedOut: 1, pendingConsent: 1, participants: 1 });
  assert.equal(d.stats.totals.workoutDays, 2);
  assert.equal(d.stats.totals.checkinDays, 1);
  assert.equal(d.stats.totals.steps, 6000);
  assert.equal(d.stats.totals.activeDays, 3, 'two workout days plus a check-in day; the opted-out person is not counted');
  assert.equal(d.complete, true);
});

test('the activity read is only asked for people who are opted in (opted-out people are never queried)', async () => {
  reset();
  await svc.getOrgDashboard(1, {}, NOW);
  assert.deepEqual(lastActivityWindow, { from: '2026-12-01', to: '2026-12-14', ids: [101, 102] },
    'Chitra (103) opted out and the invited phone has no account: neither is asked about; window starts at the programme start');
});

test('staff get the two follow-up lists: not signed in, and signed in but not consented', async () => {
  reset();
  const d = await svc.getOrgDashboard(1, {}, NOW);
  assert.deepEqual(d.actions.notSignedIn.map((m) => [m.phone, m.name]), [['9000000004', 'Dev']]);
  assert.deepEqual(d.actions.needsConsent.map((m) => [m.name, m.phone]), [['Bala Kumar', '9876543202']]);
  assert.ok(!JSON.stringify(d.actions).includes('Asha'), 'a consenting participant is not on a chase list');
  assert.ok(!JSON.stringify(d.actions).includes('Chitra'), 'someone who opted out is left alone');
});

test('the period is clamped to 7, 30 or 90 days and never starts before the programme', async () => {
  reset({ startsAt: new Date('2026-06-01T00:00:00Z') });
  assert.equal((await svc.getOrgDashboard(1, { days: 999 }, NOW)).periodDays, 30);
  assert.equal((await svc.getOrgDashboard(1, { days: 7 }, NOW)).stats.window.startDay, '2026-12-08');
  assert.equal((await svc.getOrgDashboard(1, { days: 90 }, NOW)).stats.window.startDay, '2026-09-16');
});

test('a lapsed company is frozen at its last day', async () => {
  reset({ expiresAt: new Date('2026-12-10T18:29:59.999Z') }); // end of 10 Dec IST
  const d = await svc.getOrgDashboard(1, {}, NOW);
  assert.equal(d.programme.status, 'expired');
  assert.equal(d.stats.window.endDay, '2026-12-10');
});

test('if consent/activity cannot be read nobody is counted and the page says so', async () => {
  reset();
  activity = { data: {}, complete: false };
  const d = await svc.getOrgDashboard(1, {}, NOW);
  assert.equal(d.complete, false);
  assert.equal(d.stats.counts.participants, 0);
  assert.equal(d.stats.counts.pendingConsent, null);
  assert.deepEqual(d.actions.needsConsent, []);
});

test('a programme that has not started yet reads as such, with zeros', async () => {
  reset({ startsAt: new Date('2026-12-20T00:00:00Z') });
  const d = await svc.getOrgDashboard(1, {}, NOW);
  assert.equal(d.notStarted, true);
  assert.equal(d.stats.counts.participants, 0);
});

test('unknown or invalid ids', async () => {
  reset(); org = null;
  await assert.rejects(svc.getOrgDashboard(1, {}, NOW), (e) => e.status === 404);
  await assert.rejects(svc.getOrgDashboard('x', {}, NOW), (e) => e.status === 400);
});
