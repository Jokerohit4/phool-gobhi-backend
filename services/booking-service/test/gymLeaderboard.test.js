// Covers getGymLeaderboard: window filtering (weekly/monthly/all), opt-in
// exclusion, and "my rank" computation. Run with:
//   node --experimental-test-module-mocks --test
//
// bookingService.js, @prisma/client and axios are each mocked ONCE for this
// file — same convention as memberCheckIn.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Raw MemberAttendance rows: {customerId, gymId, date}. groupBy below
// aggregates over these, honoring where.gymId and where.date.gte, the same
// way a real DB would.
let rows = [];
let users = {}; // customerId -> {id, name, profileImageUrl, leaderboardOptIn}
let batchFails = false;

function resetFakes() {
  rows = [];
  users = {};
  batchFails = false;
}

let getGymLeaderboard;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.memberAttendance = {
            groupBy: async ({ where }) => {
              const matching = rows.filter((r) =>
                r.gymId === where.gymId && (!where.date?.gte || r.date >= where.date.gte));
              const counts = new Map();
              for (const r of matching) counts.set(r.customerId, (counts.get(r.customerId) ?? 0) + 1);
              return [...counts.entries()].map(([customerId, count]) => ({ customerId, _count: { _all: count } }));
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
      },
    },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  ({ getGymLeaderboard } = await import('../services/bookingService.js'));
  assert.equal(typeof getGymLeaderboard, 'function');
});

const GYM = 9;
const TODAY = new Date().toISOString().split('T')[0];

test('only opted-in users appear, ranked by check-in count descending', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', profileImageUrl: 'a.jpg', leaderboardOptIn: true },
    2: { id: 2, name: 'Bob', profileImageUrl: null, leaderboardOptIn: true },
    3: { id: 3, name: 'Carol', profileImageUrl: null, leaderboardOptIn: false }, // opted out
  };
  rows = [
    { customerId: 1, gymId: GYM, date: TODAY },
    { customerId: 1, gymId: GYM, date: TODAY },
    { customerId: 2, gymId: GYM, date: TODAY },
    { customerId: 3, gymId: GYM, date: TODAY }, // opted out -- must not appear in entries
  ];

  const result = await getGymLeaderboard(GYM, 'all', 999); // 999 = requester, not in rows

  assert.equal(result.entries.length, 2, 'Carol excluded for not opting in');
  assert.equal(result.entries[0].customerId, 1);
  assert.equal(result.entries[0].checkIns, 2);
  assert.equal(result.entries[0].rank, 1);
  assert.equal(result.entries[1].customerId, 2);
  assert.equal(result.entries[1].rank, 2);
});

test('a different gym\'s check-ins never leak into this gym\'s board', async () => {
  resetFakes();
  users = { 1: { id: 1, name: 'Alice', leaderboardOptIn: true } };
  rows = [
    { customerId: 1, gymId: GYM, date: TODAY },
    { customerId: 1, gymId: 555, date: TODAY }, // a different gym
  ];

  const result = await getGymLeaderboard(GYM, 'all', 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].checkIns, 1, 'only this gym\'s check-in counted');
});

test('weekly window excludes check-ins from before this week', async () => {
  resetFakes();
  users = { 1: { id: 1, name: 'Alice', leaderboardOptIn: true } };
  rows = [
    { customerId: 1, gymId: GYM, date: TODAY },
    { customerId: 1, gymId: GYM, date: '2020-01-01' }, // long before this week
  ];

  const weekly = await getGymLeaderboard(GYM, 'weekly', 1);
  const all = await getGymLeaderboard(GYM, 'all', 1);

  assert.equal(weekly.entries[0].checkIns, 1, 'old check-in excluded from weekly');
  assert.equal(all.entries[0].checkIns, 2, 'both check-ins counted for all-time');
});

test('monthly window uses the 1st of the current month as the cutoff', async () => {
  resetFakes();
  users = { 1: { id: 1, name: 'Alice', leaderboardOptIn: true } };
  const monthStart = `${TODAY.slice(0, 7)}-01`;
  rows = [
    { customerId: 1, gymId: GYM, date: monthStart }, // on the boundary -- included
    { customerId: 1, gymId: GYM, date: '2020-01-01' }, // before the month -- excluded
  ];

  const result = await getGymLeaderboard(GYM, 'monthly', 1);
  assert.equal(result.entries[0].checkIns, 1);
});

test('an invalid/missing window falls back to all-time', async () => {
  resetFakes();
  users = { 1: { id: 1, name: 'Alice', leaderboardOptIn: true } };
  rows = [{ customerId: 1, gymId: GYM, date: '2020-01-01' }];

  const result = await getGymLeaderboard(GYM, 'not-a-real-window', 1);
  assert.equal(result.window, 'all');
  assert.equal(result.entries.length, 1, 'old check-in still counted under the all-time fallback');
});

test('requester with zero check-ins gets a computed rank without appearing in entries', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', leaderboardOptIn: true },
    2: { id: 2, name: 'Bob', leaderboardOptIn: true },
    99: { id: 99, name: 'Newcomer', leaderboardOptIn: false }, // the requester, never checked in
  };
  rows = [
    { customerId: 1, gymId: GYM, date: TODAY },
    { customerId: 1, gymId: GYM, date: TODAY },
    { customerId: 2, gymId: GYM, date: TODAY },
  ];

  const result = await getGymLeaderboard(GYM, 'all', 99);

  assert.equal(result.entries.length, 2, 'the requester themself is not listed');
  assert.equal(result.me.checkIns, 0);
  assert.equal(result.me.optedIn, false);
  assert.equal(result.me.rank, 3, 'would rank behind both existing entries');
});

test('requester who IS in the ranked list gets their actual list rank, not a recomputed one', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'Alice', leaderboardOptIn: true },
    2: { id: 2, name: 'Bob', leaderboardOptIn: true },
  };
  rows = [
    { customerId: 1, gymId: GYM, date: TODAY },
    { customerId: 2, gymId: GYM, date: TODAY },
    { customerId: 2, gymId: GYM, date: TODAY },
  ];

  const result = await getGymLeaderboard(GYM, 'all', 2);
  assert.equal(result.me.rank, 1, 'Bob has more check-ins than Alice');
  assert.equal(result.me.checkIns, 2);
});

test('nobody checked in at this gym yet -> empty entries, requester rank 1', async () => {
  resetFakes();
  users = { 1: { id: 1, name: 'Alice', leaderboardOptIn: false } };
  rows = [];

  const result = await getGymLeaderboard(GYM, 'all', 1);
  assert.deepEqual(result.entries, []);
  assert.equal(result.me.rank, 1);
  assert.equal(result.me.checkIns, 0);
});

test('auth-service unreachable -> fails safe with nobody ranked, opt-in unverifiable', async () => {
  resetFakes();
  batchFails = true;
  rows = [{ customerId: 1, gymId: GYM, date: TODAY }];

  const result = await getGymLeaderboard(GYM, 'all', 1);
  assert.deepEqual(result.entries, []);
  assert.equal(result.me.rank, null);
  assert.equal(result.me.optedIn, false);
});
