// Cursor pagination for GET /sessions (listSessionsPageService + listSessions
// controller): first page size and meta, walking cursors to the end, exact
// boundaries with identical startedAt, limit clamping and unchanged item shape.
//
// Run:
//   node --experimental-test-module-mocks --test test/sessionsPagination.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

let listSessionsPageService, listSessions;
let rows = [];
let lastArgs;

function fakeFindMany(args) {
  lastArgs = args;
  let list = rows.filter((r) => r.userId === args.where.userId);
  list = [...list].sort((a, b) => {
    for (const o of args.orderBy) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k] instanceof Date ? a[k].getTime() : a[k];
      const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (av !== bv) return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
  let start = 0;
  if (args.cursor) {
    const idx = list.findIndex((r) => r.id === args.cursor.id);
    start = idx === -1 ? list.length : idx;
  }
  start += args.skip || 0;
  return Promise.resolve(list.slice(start, start + args.take));
}

test('setup', async (t) => {
  t.mock.module('../services/routineJourneyService.js', { exports: { recordRoutineWorkout: async () => null } });
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class { constructor() { this.workoutSession = { findMany: fakeFindMany }; } },
      Prisma: { Decimal: class Decimal {} },
    },
  });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: { notifyWorkoutFinished: async () => ({}) },
  });
  t.mock.module(new URL('../middleware/requireFeatureFlag.js', import.meta.url).href, {
    exports: { isAnyFeatureEnabled: async () => true },
  });
  ({ listSessionsPageService } = await import('../services/workoutSessionService.js'));
  ({ listSessions } = await import('../controllers/sessionController.js'));
});

function seed(n, { same = false } = {}) {
  rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: i, userId: 1, templateId: null, name: `s${i}`,
      startedAt: same ? new Date('2026-09-01T10:00:00Z') : new Date(Date.UTC(2026, 8, 1, 10, i)),
      exercises: [{ id: i * 10, sets: [{ id: i * 100, reps: 5 }] }],
    });
  }
  rows.push({ id: 5000, userId: 2, startedAt: new Date(), exercises: [] });
}

async function walk(limit) {
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard++) {
    const { items, meta } = await listSessionsPageService(1, { limit, cursor });
    pages.push({ ids: items.map((s) => s.id), meta });
    if (!meta.hasMore) break;
    cursor = meta.nextCursor;
  }
  return pages;
}

function mkRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('first page: size = limit, meta, startedAt desc, includeFull kept, limit+1 fetched', async () => {
  seed(12);
  const { items, meta } = await listSessionsPageService(1, { limit: 5 });
  assert.deepEqual(items.map((s) => s.id), [12, 11, 10, 9, 8]);
  assert.deepEqual(meta, { nextCursor: 8, hasMore: true });
  assert.equal(lastArgs.take, 6);
  assert.deepEqual(lastArgs.orderBy, [{ startedAt: 'desc' }, { id: 'desc' }]);
  assert.ok(lastArgs.include.exercises, 'full include is preserved');
  assert.equal(lastArgs.cursor, undefined);
});

test('following the cursor to the end visits every row once; last page hasMore false', async () => {
  seed(12);
  const pages = await walk(5);
  assert.deepEqual(pages.map((p) => p.ids), [[12, 11, 10, 9, 8], [7, 6, 5, 4, 3], [2, 1]]);
  assert.deepEqual(pages[2].meta, { nextCursor: null, hasMore: false });
  assert.deepEqual(lastArgs.cursor, { id: 3 });
  assert.equal(lastArgs.skip, 1);
});

test('exact boundary: total == limit and total == 2*limit give no empty trailing page', async () => {
  seed(5);
  assert.equal((await walk(5)).length, 1);
  seed(10);
  const pages = await walk(5);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1].meta, { nextCursor: null, hasMore: false });
});

test('identical startedAt: id tiebreak keeps pages disjoint and complete', async () => {
  seed(11, { same: true });
  const all = (await walk(4)).flatMap((p) => p.ids);
  assert.deepEqual(all, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test('controller: default limit 30, response {data, meta}, item shape unchanged', async () => {
  seed(45);
  const res = mkRes();
  await listSessions({ userId: 1, query: {} }, res);
  assert.equal(res.body.data.length, 30);
  assert.deepEqual(res.body.meta, { nextCursor: res.body.data[29].id, hasMore: true });
  assert.deepEqual(Object.keys(res.body.data[0]).sort(),
    ['exercises', 'id', 'name', 'startedAt', 'templateId', 'userId']);
  assert.equal(res.body.data[0].exercises[0].sets[0].reps, 5);

  const res2 = mkRes();
  await listSessions({ userId: 1, query: { cursor: String(res.body.meta.nextCursor) } }, res2);
  assert.equal(res2.body.data.length, 15);
  assert.deepEqual(res2.body.meta, { nextCursor: null, hasMore: false });
});

test('controller: limit clamping 0, -1, abc -> 30; 5000 -> 100', async () => {
  seed(150);
  for (const [raw, expected] of [['0', 30], ['-1', 30], ['abc', 30], ['5000', 100], ['7', 7]]) {
    const res = mkRes();
    await listSessions({ userId: 1, query: { limit: raw } }, res);
    assert.equal(res.body.data.length, expected, `limit=${raw}`);
  }
});
