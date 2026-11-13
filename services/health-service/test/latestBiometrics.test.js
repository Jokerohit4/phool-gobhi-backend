// Items 1+2: "newest row per metric" without reading the whole history, the
// blended-score in-process memo, and its eviction through invalidateBlendedScore.
// Run with: node --experimental-test-module-mocks --test
process.env.HEALTH_CACHE_FORCE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

let rows = [];
let log;
let snapshotSelects;
const db = {
  scoreDaySnapshot: {
    findMany: async () => [],
    findFirst: async (args) => { snapshotSelects.push(args.select); return { close: 250 }; },
  },
  biometricEntry: {
    groupBy: async ({ where }) => {
      log.push('groupBy');
      const by = new Map();
      for (const e of rows.filter((r) => r.userId === where.userId)) {
        const cur = by.get(e.metric);
        if (!cur || e.localDate > cur) by.set(e.metric, e.localDate);
      }
      return [...by].map(([metric, localDate]) => ({ metric, _max: { localDate } }));
    },
    findMany: async ({ where, select }) => {
      log.push({ findMany: where, select });
      assert.ok(where.OR, 'must fetch only the newest pairs, never the full history');
      return rows
        .filter((e) => e.userId === where.userId && where.OR.some((c) => c.metric === e.metric && c.localDate === e.localDate))
        .map((e) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, e[k]])) : { ...e }));
    },
  },
};
let latestByMetricService, getBlendedScore, invalidateBlendedScore;

function seed() {
  log = []; snapshotSelects = [];
  rows = [
    { id: 1, userId: 1, metric: 'weight', value: 75, localDate: '2026-09-06', createdAt: new Date('2026-09-06') },
    { id: 2, userId: 1, metric: 'weight', value: 74.2, localDate: '2026-09-08', createdAt: new Date('2026-09-08') },
    { id: 3, userId: 1, metric: 'weight', value: 99, localDate: '2026-01-01', createdAt: new Date('2026-12-01') },
    { id: 4, userId: 1, metric: 'body_fat', value: 18, localDate: '2026-09-07', createdAt: new Date('2026-09-07') },
    { id: 5, userId: 2, metric: 'hrv', value: 50, localDate: '2026-09-09', createdAt: new Date('2026-09-09') },
  ];
}

test('setup', async (t) => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class { constructor() { return db; } }, Prisma: {} } });
  const store = new Map();
  t.mock.module('../utils/redisClient.js', {
    exports: { default: { get: async () => null, set: async () => null, del: async (k) => store.delete(k) } },
  });
  t.mock.module('../utils/notifyChallengeService.js', {
    exports: { creditWeeklyConsistencyCoins: async () => true, notifyWorkoutFinished: async () => {} },
  });
  ({ latestByMetricService } = await import('../services/biometricService.js'));
  ({ getBlendedScore } = await import('../services/ledger/scoreService.js'));
  ({ invalidateBlendedScore } = await import('../services/ledger/blendedScoreCache.js'));
});

test('latestByMetric: same output as "first per metric over localDate desc", never reads full history', async () => {
  seed();
  const latest = await latestByMetricService(1);
  assert.deepEqual(Object.keys(latest).sort(), ['body_fat', 'weight']);
  assert.equal(latest.weight.value, 74.2);
  assert.equal(latest.weight.localDate, '2026-09-08');
  assert.equal(latest.body_fat.value, 18);
  assert.equal(log.length, 2, 'one grouped pass + one indexed fetch, regardless of history size');
  const fetched = log[1].findMany.OR;
  assert.equal(fetched.length, 2);
  assert.deepEqual(await latestByMetricService(99), {});
  // iteration order matches the old localDate-desc order (weight 09-08 before body_fat 09-07)
  assert.deepEqual(Object.keys(latest), ['weight', 'body_fat']);
});

test('blended score: markers use only newest-per-metric, snapshot read selects just close', async () => {
  seed();
  await invalidateBlendedScore(1);
  const out = await getBlendedScore(db, { userId: 1 });
  assert.equal(out.behavioralScore, 250);
  assert.deepEqual(snapshotSelects, [{ close: true }]);
  const bio = log.find((e) => e.findMany);
  assert.deepEqual(Object.keys(bio.select).sort(), ['createdAt', 'localDate', 'metric', 'value']);
});

test('blended score: served from the in-process memo until invalidateBlendedScore evicts it', async () => {
  seed();
  await invalidateBlendedScore(1);
  await getBlendedScore(db, { userId: 1 });
  const afterFirst = log.length;
  await getBlendedScore(db, { userId: 1 });
  assert.equal(log.length, afterFirst, 'second read hit the memo (no DB reads)');
  await invalidateBlendedScore(1);
  await getBlendedScore(db, { userId: 1 });
  assert.ok(log.length > afterFirst, 'invalidate -> recomputed');
  // other users are unaffected by evicting user 1
  await getBlendedScore(db, { userId: 2 });
  const n = log.length;
  await invalidateBlendedScore(1);
  await getBlendedScore(db, { userId: 2 });
  assert.equal(log.length, n, 'user 2 still memoised');
});
