// Cursor pagination for GET /wallet/transactions: service-level page boundaries
// (incl. identical createdAt), meta, item shape, and limit/cursor parsing.
//
// Run:
//   node --experimental-test-module-mocks --test test/transactionsPagination.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

let getWalletTransactionsPageService;
let parseLimit, parseCursor;
let rows;
let lastArgs;

// Minimal in-memory findMany honouring orderBy[], cursor{id}, skip, take.
function fakeFindMany(args) {
  lastArgs = args;
  let list = rows.filter((r) => r.walletId === args.where.walletId);
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
  const mockPrisma = {
    wallet: { findUnique: async ({ where }) => (where.userId === 10 ? { id: 1, userId: 10, balance: '0' } : null) },
    walletTransaction: { findMany: fakeFindMany },
    razorpayOrder: {},
    $transaction: async (fn) => fn(mockPrisma),
  };
  t.mock.module('@prisma/client', { exports: { PrismaClient: class { constructor() { return mockPrisma; } }, Prisma: {} } });
  t.mock.module('../utils/analytics.js', { exports: { track: () => {} } });
  ({ getWalletTransactionsPageService } = await import('../services/walletService.js'));
  ({ parseLimit, parseCursor } = await import('../utils/pagination.js'));
});

function seed(n, { sameTimestamp = false } = {}) {
  rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: i, walletId: 1, type: 'credit', amount: String(i * 10),
      createdAt: sameTimestamp ? new Date('2026-09-01T00:00:00Z') : new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
    });
  }
  rows.push({ id: 999, walletId: 2, type: 'credit', amount: '1', createdAt: new Date() }); // other wallet
}

async function walk(limit) {
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard++) {
    const { items, meta } = await getWalletTransactionsPageService(10, { limit, cursor });
    pages.push({ ids: items.map((i) => i.id), meta });
    if (!meta.hasMore) break;
    cursor = meta.nextCursor;
  }
  return pages;
}

test('first page: size = limit, meta.hasMore true, nextCursor = last id, newest first', async () => {
  seed(12);
  const { items, meta } = await getWalletTransactionsPageService(10, { limit: 5, cursor: null });
  assert.deepEqual(items.map((i) => i.id), [12, 11, 10, 9, 8]);
  assert.deepEqual(meta, { nextCursor: 8, hasMore: true });
  assert.equal(lastArgs.take, 6, 'limit + 1 look-ahead');
  assert.deepEqual(lastArgs.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(lastArgs.cursor, undefined);
});

test('item shape unchanged: serializeTransaction output (amount string -> number)', async () => {
  seed(2);
  const { items } = await getWalletTransactionsPageService(10, { limit: 50 });
  assert.equal(items[0].id, 2);
  assert.equal(items[0].amount, 20);
  assert.equal(items[0].type, 'credit');
});

test('following the cursor to the end visits every row exactly once; last page hasMore false', async () => {
  seed(12);
  const pages = await walk(5);
  assert.deepEqual(pages.map((p) => p.ids), [[12, 11, 10, 9, 8], [7, 6, 5, 4, 3], [2, 1]]);
  assert.deepEqual(pages[2].meta, { nextCursor: null, hasMore: false });
  assert.equal(lastArgs.skip, 1);
  assert.deepEqual(lastArgs.cursor, { id: 3 });
});

test('exact boundary: total == limit and total == 2*limit never produce an empty trailing page', async () => {
  seed(5);
  let pages = await walk(5);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].meta, { nextCursor: null, hasMore: false });
  seed(10);
  pages = await walk(5);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1].meta, { nextCursor: null, hasMore: false });
});

test('identical createdAt: id tiebreak keeps pages disjoint and complete', async () => {
  seed(11, { sameTimestamp: true });
  const pages = await walk(4);
  const all = pages.flatMap((p) => p.ids);
  assert.deepEqual(all, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(new Set(all).size, 11);
});

test('empty wallet -> no items, hasMore false; unknown wallet throws', async () => {
  rows = [];
  const { items, meta } = await getWalletTransactionsPageService(10, { limit: 50 });
  assert.deepEqual(items, []);
  assert.deepEqual(meta, { nextCursor: null, hasMore: false });
  await assert.rejects(() => getWalletTransactionsPageService(404, { limit: 50 }), { message: 'Wallet not found' });
});

test('limit clamping (default 50, max 100): 0, -1, abc, 5000', () => {
  assert.equal(parseLimit(undefined, 50, 100), 50);
  assert.equal(parseLimit('0', 50, 100), 50);
  assert.equal(parseLimit('-1', 50, 100), 50);
  assert.equal(parseLimit('abc', 50, 100), 50);
  assert.equal(parseLimit('5000', 50, 100), 100);
  assert.equal(parseLimit('25', 50, 100), 25);
  assert.equal(parseLimit('2.5', 50, 100), 50);
});

test('cursor parsing: positive integers only', () => {
  assert.equal(parseCursor('42'), 42);
  assert.equal(parseCursor(undefined), null);
  assert.equal(parseCursor('abc'), null);
  assert.equal(parseCursor('-3'), null);
  assert.equal(parseCursor('0'), null);
});
