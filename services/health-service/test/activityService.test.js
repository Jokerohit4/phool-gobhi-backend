// Daily-activity reads: the public per-user read (strictly req.userId) and
// the internal multi-user feed booking-service's leaderboard score uses.
// What's under test: the single-user filter stays single-user, the internal
// feed maps `id IN (...)` + the same date-range semantics, and the internal
// controller validates its `ids` batch before touching the service.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let activityRows = [];
let sleepRows = [];

function resetFakes() {
  sleepRows = [];
  activityRows = [
    { id: 1, userId: 1, date: '2026-09-01', steps: 8000, source: 'healthkit' },
    { id: 2, userId: 1, date: '2026-09-08', steps: 12000, source: 'healthkit' },
    { id: 3, userId: 2, date: '2026-09-01', steps: 5000, source: 'health_connect' },
    { id: 4, userId: 3, date: '2026-08-25', steps: 2000, source: 'health_connect' },
  ];
}

let getDailyActivityService, getDailyActivityForUsersService, syncDailyActivityService;
let getDailyActivityInternal;

test('setup: mock prisma once, import the services and controller once', async (t) => {
  resetFakes();
  t.mock.module(new URL('../services/ledger/blendedScoreCache.js', import.meta.url).href, {
    exports: { invalidateBlendedScore: async () => {} },
  });
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.$transaction = async (writes) => writes.map((write) => write());
          this.biometricEntry = {
            createMany: ({ data: [entry], skipDuplicates }) => () => {
              assert.equal(skipDuplicates, true);
              if (sleepRows.some((row) =>
                row.userId === entry.userId && row.metric === entry.metric &&
                row.localDate === entry.localDate)) return { count: 0 };
              sleepRows.push({ ...entry });
              return { count: 1 };
            },
            updateMany: ({ where, data }) => () => {
              const matches = sleepRows.filter((row) =>
                row.userId === where.userId && row.metric === where.metric &&
                row.localDate === where.localDate && where.source.in.includes(row.source) &&
                row.value !== where.value.not);
              for (const row of matches) Object.assign(row, data);
              return { count: matches.length };
            },
          };
          this.dailyActivityMetric = {
            upsert: ({ where, create, update }) => () => {
              const key = where.userId_date;
              const existing = activityRows.find((row) =>
                row.userId === key.userId && row.date === key.date);
              if (existing) return Object.assign(existing, update);
              activityRows.push(create);
              return create;
            },
            findMany: async ({ where, orderBy }) => {
              let rows = activityRows;
              if (where.userId !== undefined) {
                rows = rows.filter((r) =>
                  where.userId && typeof where.userId === 'object' && where.userId.in
                    ? where.userId.in.includes(r.userId)
                    : r.userId === where.userId,
                );
              }
              if (where.date) {
                if (where.date.gte) rows = rows.filter((r) => r.date >= where.date.gte);
                if (where.date.lte) rows = rows.filter((r) => r.date <= where.date.lte);
              }
              const clause = orderBy;
              const [field, direction] = Object.entries(clause ?? {})[0] ?? ['date', 'desc'];
              rows = [...rows].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
              return direction === 'desc' ? rows.reverse() : rows;
            },
          };
        }
      },
      // serializeDecimals (pulled in by the controller) does an
      // `instanceof Prisma.Decimal`; a bare class satisfies that without
      // dragging real Prisma into the test.
      Prisma: { Decimal: class Decimal {} },
    },
  });
  ({ getDailyActivityService, getDailyActivityForUsersService, syncDailyActivityService } = await import(
    '../services/activityService.js'
  ));
  ({ getDailyActivityInternal } = await import('../controllers/activityController.js'));
});

test('device sleep sync updates imported entries and preserves manual sleep and existing steps', async () => {
  resetFakes();
  const row = { date: '2026-09-01', source: 'healthkit', sleepMinutes: 420 };
  await syncDailyActivityService(1, [row]);
  assert.deepEqual(sleepRows, [{
    userId: 1, metric: 'sleep_minutes', localDate: row.date,
    value: 420, unit: 'minutes', source: 'healthkit',
  }]);
  assert.equal(activityRows[0].steps, 8000);
  await syncDailyActivityService(1, [{ ...row, steps: 9000, sleepMinutes: 430 }]);
  assert.equal(sleepRows.length, 1);
  assert.equal(sleepRows[0].value, 430);
  assert.equal(activityRows[0].steps, 9000);
  Object.assign(sleepRows[0], { source: 'manual', value: 445 });
  await syncDailyActivityService(1, [{ ...row, sleepMinutes: 460 }]);
  assert.equal(sleepRows[0].value, 445);
  assert.equal(sleepRows[0].source, 'manual');
  assert.equal(activityRows[0].steps, 9000);
  resetFakes();
});

test('partial and empty device snapshots preserve previously synced activity', async () => {
  resetFakes();
  const date = '2026-09-01';
  const source = 'healthkit';
  await syncDailyActivityService(1, [{
    date, source, steps: 8000, activeCalories: 300, distanceMeters: 6100,
    restingHeartRateBpm: 55,
  }]);
  await syncDailyActivityService(1, [{ date, source, steps: 9000, restingHeartRateBpm: null }]);
  const result = await syncDailyActivityService(1, [{ date, source, steps: null }]);
  assert.equal(result.length, 0);
  assert.equal(activityRows[0].steps, 9000);
  assert.equal(activityRows[0].activeCalories, 300);
  assert.equal(activityRows[0].distanceMeters, 6100);
  assert.equal(activityRows[0].restingHeartRateBpm, 55);
  await syncDailyActivityService(1, [{ date, source, steps: 0 }]);
  assert.equal(activityRows[0].steps, 0);
  resetFakes();
});

test('public read: only the requesting user\'s rows, honor the date range', async () => {
  const all = await getDailyActivityService(1, {});
  assert.equal(all.length, 2, 'user 1 sees only their two rows');
  assert.ok(all.every((r) => r.userId === 1));

  const ranged = await getDailyActivityService(1, { from: '2026-09-08', to: '2026-09-08' });
  assert.equal(ranged.length, 1);
  assert.equal(ranged[0].steps, 12000);
});

test('internal feed: userId IN (...) across a window, same date semantics', async () => {
  const row = await getDailyActivityForUsersService([1, 2], { from: '2026-09-01', to: '2026-09-30' });
  const userIds = [...new Set(row.map((r) => r.userId))];
  assert.deepEqual(userIds.sort(), [1, 2], 'users outside the batch excluded');
  assert.ok(row.every((r) => r.date >= '2026-09-01' && r.date <= '2026-09-30'));
});

test('internal controller: empty ids -> 400, over-limit ids -> 400, else reads the feed', async () => {
  const makeRes = () => {
    const res = {};
    res.status = (s) => {
      res.statusCode = s;
      return res;
    };
    res.json = (b) => {
      res.body = b;
      return res;
    };
    return res;
  };

  const empty = makeRes();
  await getDailyActivityInternal({ query: {} }, empty);
  assert.equal(empty.statusCode, 400);

  const tooMany = makeRes();
  await getDailyActivityInternal(
    { query: { ids: Array.from({ length: 501 }, (_, i) => i + 1).join(',') } },
    tooMany,
  );
  assert.equal(tooMany.statusCode, 400);

  const ok = makeRes();
  await getDailyActivityInternal({ query: { ids: '1,2', from: '2026-09-01' } }, ok);
  const returnedIds = [...new Set(ok.body.data.map((r) => r.userId))];
  assert.deepEqual(returnedIds.sort(), [1, 2], 'both in-batch users returned');
  assert.ok(ok.body.data.every((r) => r.date >= '2026-09-01'));
});
