// Covers getGlobalLeaderboard: cross-gym population (any member check-in OR
// any attendance event in the window), opt-in exclusion, check-ins = distinct
// presence days across all gyms, the same composite score ranking, and the
// per-criterion `me.ranks`. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Raw MemberAttendance rows {customerId, gymId, date}; findMany below filters
// by date >= where.date.gte and applies the (customerId, date) distinct, the
// same way the service asks a real DB for it.
let rows = [];
let users = {};
let batchFails = false;
let attendanceEvents = [];
let activityRows = [];
let feedFails = false;

function resetFakes() {
  rows = [];
  users = {};
  batchFails = false;
  attendanceEvents = [];
  activityRows = [];
  feedFails = false;
}

let getGlobalLeaderboard;

test('setup: mock dependencies once, import globalLeaderboardService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.memberAttendance = {
            findMany: async ({ where, distinct }) => {
              const gte = where?.date?.gte;
              let out = rows.filter((r) => !gte || r.date >= gte);
              if (distinct?.includes('customerId') && distinct?.includes('date')) {
                const seen = new Set();
                out = out.filter((r) => {
                  const k = `${r.customerId}:${r.date}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
              }
              return out;
            },
          };
        }
      },
      Prisma: {},
    },
  });

  t.mock.module('axios', {
    exports: {
      default: {
        post: async (url, body) => {
          if (batchFails) throw new Error('auth-service unreachable');
          assert.ok(url.includes('/internal/users/batch'));
          const data = body.ids.map((id) => users[id]).filter(Boolean);
          return { data: { data } };
        },
        get: async (url) => {
          if (feedFails) throw new Error('feature downstream unreachable');
          if (url.includes('/internal/attendance-events')) {
            return { data: { data: attendanceEvents } };
          }
          if (url.includes('/internal/daily-activity')) {
            return { data: { data: activityRows } };
          }
          throw new Error(`unexpected GET ${url}`);
        },
      },
    },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  ({ getGlobalLeaderboard } = await import('../services/globalLeaderboardService.js'));
  assert.equal(typeof getGlobalLeaderboard, 'function');
});

const TODAY = new Date().toISOString().split('T')[0];
const key = (offset) => new Date(Date.now() - offset * 86400000).toISOString().split('T')[0];

test('cross-gym member days are deduped: same day at two gyms = one check-in', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', profileImageUrl: 'a.jpg', leaderboardOptIn: true },
    99: { id: 99, name: 'Requester', leaderboardOptIn: false },
  };
  rows = [
    { customerId: 1, gymId: 9, date: TODAY },
    { customerId: 1, gymId: 555, date: TODAY }, // same day, another gym
  ];
  // Events from both gyms same day: attendance pays once (best-trust/day).
  attendanceEvents = [
    { userId: 1, gymId: 9, attendedAt: new Date().toISOString(), source: 'member_checkin' },
    { userId: 1, gymId: 555, attendedAt: new Date().toISOString(), source: 'member_checkin' },
  ];

  const result = await getGlobalLeaderboard('weekly', 99);

  assert.equal(result.global, true);
  assert.equal(result.window, 'weekly');
  assert.equal(result.windowDays, 7);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].checkIns, 1, 'two gyms the same day still count as one presence day');
  assert.equal(result.entries[0].attendanceScore, 18, 'one member_checkin day = 17.5 -> 18');
  assert.equal(result.entries[0].score, 19, '18 attendance + 1 recent');
});

test('any gym has presence: a gym-555-only user ranks on the global board', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', leaderboardOptIn: true },
    2: { id: 2, name: 'Bob', leaderboardOptIn: true },
    99: { id: 99, name: 'Requester', leaderboardOptIn: false },
  };
  rows = [
    { customerId: 1, gymId: 9, date: TODAY },
    { customerId: 2, gymId: 555, date: TODAY },
  ];
  attendanceEvents = [
    { userId: 1, gymId: 9, attendedAt: new Date().toISOString(), source: 'member_checkin' },
    { userId: 2, gymId: 555, attendedAt: new Date().toISOString(), source: 'booking' },
  ];

  const result = await getGlobalLeaderboard('weekly', 99);

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].customerId, 1, 'higher-trust presence leads');
  assert.equal(result.entries[1].customerId, 2);
  assert.equal(result.entries[1].score, 17, 'booking trust day -> 15.75 + 1.43 recent = 17');
});

test('event-only users (no member row) are in the population and ranked', async () => {
  resetFakes();
  users = {
    3: { id: 3, name: 'Carol', leaderboardOptIn: true },
    99: { id: 99, name: 'Requester', leaderboardOptIn: false },
  };
  rows = [];
  attendanceEvents = [{ userId: 3, gymId: 555, attendedAt: new Date().toISOString(), source: 'self_checkin' }];

  const result = await getGlobalLeaderboard('weekly', 99);

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].customerId, 3);
  assert.equal(result.entries[0].checkIns, 0, 'no member attendance days, but the event still earned score');
});

test('steps count toward the global score for a user whose presence is elsewhere', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', leaderboardOptIn: true },
    99: { id: 99, name: 'Requester', leaderboardOptIn: false },
  };
  rows = [{ customerId: 1, gymId: 555, date: TODAY }];
  attendanceEvents = [{ userId: 1, gymId: 555, attendedAt: new Date().toISOString(), source: 'member_checkin' }];
  activityRows = Array.from({ length: 7 }, (_, i) => ({ userId: 1, date: key(i), steps: 10000 }));

  const result = await getGlobalLeaderboard('weekly', 99);

  assert.equal(result.entries[0].stepsScore, 20, 'full 10k/day week maxes the steps bucket');
  // 17.5 attendance (one member day) + 20 steps + 1.43 recent = 38.93 -> 39.
  assert.equal(result.entries[0].score, 39);
});

test('per-criterion ranks include the requester even when opted out', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', leaderboardOptIn: true },
    2: { id: 2, name: 'Bob', leaderboardOptIn: true },
    99: { id: 99, name: 'Requester', leaderboardOptIn: false },
  };
  rows = [
    { customerId: 1, gymId: 9, date: TODAY },
    { customerId: 2, gymId: 555, date: TODAY },
  ];
  attendanceEvents = [{ userId: 1, gymId: 9, attendedAt: new Date().toISOString(), source: 'member_checkin' }];

  const result = await getGlobalLeaderboard('weekly', 99);

  assert.equal(result.me.rank, 3, 'requester without any score ranks behind both opted-in users');
  assert.equal(result.me.rank, result.entries.length + 1);
  assert.equal(result.me.ranks.attendance.rank, 3);
  assert.equal(result.me.ranks.attendance.score, 0);
  assert.equal(result.entries[0].attendanceScore, 18);
  assert.equal(result.me.score, 0);
  assert.equal(result.me.optedIn, false);
});

test('opted-out users are excluded from the global entries', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', leaderboardOptIn: true },
    4: { id: 4, name: 'Ghost', leaderboardOptIn: false },
  };
  rows = [
    { customerId: 1, gymId: 9, date: TODAY },
    { customerId: 4, gymId: 9, date: TODAY },
  ];

  const result = await getGlobalLeaderboard('all', 1);

  assert.equal(result.entries.length, 1, 'Ghost opted out');
  assert.equal(result.entries[0].customerId, 1);
  assert.equal(result.windowDays, 90);
});

test('auth-service unreachable -> fails safe with nobody ranked', async () => {
  resetFakes();
  batchFails = true;
  rows = [{ customerId: 1, gymId: 9, date: TODAY }];

  const result = await getGlobalLeaderboard('weekly', 1);
  assert.deepEqual(result.entries, []);
  assert.equal(result.me.rank, null);
  assert.equal(result.me.optedIn, false);
});

test('a down score feed degrades to member-days-only rather than failing the board', async () => {
  resetFakes();
  feedFails = true;
  users = { 1: { id: 1, name: 'Alice', leaderboardOptIn: true } };
  rows = [
    { customerId: 1, gymId: 9, date: TODAY },
    { customerId: 1, gymId: 555, date: TODAY },
  ];

  const result = await getGlobalLeaderboard('weekly', 1);
  assert.equal(result.entries.length, 1, 'board still renders with both feeds down');
  assert.equal(result.entries[0].checkIns, 1);
  assert.equal(result.entries[0].score, 0, 'no feed data -> zero composite');
});