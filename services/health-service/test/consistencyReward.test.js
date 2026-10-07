// The weekly consistency bonus: one 7-day average (behavioralAverages) feeding
// the Health Score card's bar, the coin reward and buddy-service's leagues.
// All three used to read a `dailyScore` model that does not exist in the schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TODAY = '2026-10-08'; // a Thursday
const USER = 7;

// close 500 normalises to 100, 400 to 80, 250 to 50.
let snapshots = [];
const fakePrisma = {
  scoreDaySnapshot: {
    findMany: async ({ where, distinct }) => {
      let rows = snapshots.filter((s) =>
        (!where.userId?.in || where.userId.in.includes(s.userId))
        && s.localDate >= where.localDate.gte && s.localDate < where.localDate.lt);
      if (distinct) rows = [...new Map(rows.map((r) => [r.userId, r])).values()];
      return rows;
    },
  },
};
const day = (offset) => {
  const d = new Date(Date.UTC(2026, 9, 8 + offset));
  return d.toISOString().slice(0, 10);
};
const week = (userId, close, days = 7) =>
  Array.from({ length: days }, (_, i) => ({ userId, localDate: day(-(i + 1)), close }));

const credits = [];
let creditSucceeds = true;
let behavioralAverages;
let getBatchBehavioralConsistency;
let evaluateUserReward;
let weekStartIST;

test('setup: mock the coin credit and Prisma, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class { constructor() { return fakePrisma; } }, Prisma: {} },
  });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: {
      creditWeeklyConsistencyCoins: async (args) => { credits.push(args); return creditSucceeds; },
      notifyWorkoutFinished: async () => ({}),
      creditProfileQuestionCoin: async () => true,
    },
  });
  ({ behavioralAverages, getBatchBehavioralConsistency } = await import('../services/ledger/scoreService.js'));
  ({ evaluateUserReward, weekStartIST } = await import('../services/rewardService.js'));
});

test('average is over all seven days - missing days count as zero', async () => {
  snapshots = week(USER, 500, 3); // three perfect days, four missing
  const avg = await behavioralAverages(fakePrisma, { userIds: [USER], today: TODAY });
  assert.equal(avg.get(USER), 42.9);
});

test('a full week at close 400 averages exactly 80, today excluded', async () => {
  snapshots = [...week(USER, 400), { userId: USER, localDate: TODAY, close: 0 }];
  const avg = await behavioralAverages(fakePrisma, { userIds: [USER], today: TODAY });
  assert.equal(avg.get(USER), 80);
});

test('leagues get the same figure per user', async () => {
  snapshots = [...week(USER, 500), ...week(8, 250)];
  const rows = await getBatchBehavioralConsistency(fakePrisma, { userIds: [USER, 8] });
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.userId, r.avgScore])),
    { [USER]: 100, 8: 50 },
  );
});

test('the bonus week starts on Monday in IST', () => {
  assert.equal(weekStartIST('2026-10-08'), '2026-10-05'); // Thursday
  assert.equal(weekStartIST('2026-10-05'), '2026-10-05'); // Monday
  assert.equal(weekStartIST('2026-10-11'), '2026-10-05'); // Sunday
});

test('above the bar pays 50 coins, keyed on the week', async () => {
  credits.length = 0;
  snapshots = week(USER, 450);
  const result = await evaluateUserReward(USER, { today: TODAY });
  assert.equal(result.status, 'rewarded');
  assert.deepEqual(credits, [{ userId: USER, weekStart: '2026-10-05', amount: 50, average: 90 }]);
});

test('below the bar pays nothing', async () => {
  credits.length = 0;
  snapshots = week(USER, 250);
  const result = await evaluateUserReward(USER, { today: TODAY });
  assert.equal(result.status, 'ignored');
  assert.equal(credits.length, 0);
});

test('a failed credit is reported, not swallowed as rewarded', async () => {
  credits.length = 0;
  creditSucceeds = false;
  try {
    snapshots = week(USER, 500);
    const result = await evaluateUserReward(USER, { today: TODAY });
    assert.equal(result.status, 'failed');
  } finally {
    creditSucceeds = true;
  }
});
