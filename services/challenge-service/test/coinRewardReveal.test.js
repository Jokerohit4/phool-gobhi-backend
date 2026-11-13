// "While you were away": coin credits the person was never shown a reward
// moment for (a slow request, a closed app, a lost reply).
//
//   1. Only ACTIVITY credits are listed. A refund or a redemption is a credit
//      too, but nobody should be celebrated for getting their own coins back.
//   2. Debits, other people's credits, already-revealed credits and credits
//      older than three days are never listed.
//   3. Marking with ids marks exactly those; marking with none marks every
//      credit made up to now (what the app sends once its queue has drained).
//   4. One person's reveal can never touch another person's rows.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let rows = [];
let nextId = 1;

function reset() {
  rows = [];
  nextId = 1;
}

function add(fields) {
  const row = {
    id: nextId++,
    userId: 1,
    type: 'credit',
    amount: 10,
    description: 'Workout activity',
    idempotencyKey: `workout-credit:${nextId}`,
    createdAt: new Date('2026-11-06T10:00:00Z'),
    revealedAt: null,
    ...fields,
  };
  rows.push(row);
  return row;
}

// Just enough of Prisma's where semantics for the filters the service uses.
function matches(row, where) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((alt) => matches(row, alt));
    const value = row[key];
    if (cond === null) return value === null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('gte' in cond) return value >= cond.gte;
      if ('lte' in cond) return value <= cond.lte;
      if ('in' in cond) return cond.in.includes(value);
      if ('startsWith' in cond) return typeof value === 'string' && value.startsWith(cond.startsWith);
    }
    return value === cond;
  });
}

let service;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.coinLedgerEntry = {
            findMany: async ({ where, orderBy, take, select }) => {
              let found = rows.filter((r) => matches(r, where));
              if (orderBy?.createdAt === 'asc') {
                found = [...found].sort((a, b) => a.createdAt - b.createdAt);
              }
              if (take) found = found.slice(0, take);
              return found.map((r) =>
                select
                  ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))
                  : r,
              );
            },
            updateMany: async ({ where, data }) => {
              const found = rows.filter((r) => matches(r, where));
              for (const r of found) Object.assign(r, data);
              return { count: found.length };
            },
          };
        }
      },
    },
  });
  service = await import('../services/coinLedgerService.js');
});

const NOW = new Date('2026-11-06T12:00:00Z');

test('lists activity credits that were never revealed, oldest first, with a total', async () => {
  reset();
  const later = add({ amount: 5, idempotencyKey: 'workout-photo-9', createdAt: new Date('2026-11-06T11:00:00Z') });
  const earlier = add({ amount: 15, idempotencyKey: 'workout-credit:8' });
  const out = await service.getUnrevealedRewardsService(1, { now: NOW });
  assert.deepEqual(out.entries.map((e) => e.id), [earlier.id, later.id]);
  assert.equal(out.coins, 20);
  assert.deepEqual(Object.keys(out.entries[0]).sort(), ['amount', 'createdAt', 'description', 'id']);
});

test('refunds, debits, other people, revealed and old credits are not listed', async () => {
  reset();
  add({ idempotencyKey: 'redemption-refund:5' }); // a credit, but not a celebration
  add({ type: 'debit', idempotencyKey: 'routine:spend' });
  add({ userId: 2, idempotencyKey: 'workout-credit:2' });
  add({ idempotencyKey: 'workout-credit:3', revealedAt: new Date('2026-11-06T10:30:00Z') });
  add({ idempotencyKey: 'workout-credit:4', createdAt: new Date('2026-11-02T10:00:00Z') });
  add({ idempotencyKey: null });
  const mine = add({ idempotencyKey: 'routine:water:2026-11-06' });
  const out = await service.getUnrevealedRewardsService(1, { now: NOW });
  assert.deepEqual(out.entries.map((e) => e.id), [mine.id]);
});

test('marking with ids marks exactly those, once', async () => {
  reset();
  const a = add({ idempotencyKey: 'workout-credit:1' });
  const b = add({ idempotencyKey: 'workout-credit:2' });
  const first = await service.markRewardsRevealedService(1, { ids: [a.id], now: NOW });
  assert.equal(first.revealed, 1);
  assert.deepEqual(a.revealedAt, NOW);
  assert.equal(b.revealedAt, null);
  const again = await service.markRewardsRevealedService(1, { ids: [a.id], now: NOW });
  assert.equal(again.revealed, 0);
  assert.equal((await service.getUnrevealedRewardsService(1, { now: NOW })).entries.length, 1);
});

test('marking with no ids marks every credit made up to now', async () => {
  reset();
  add({ idempotencyKey: 'workout-credit:1' });
  add({ idempotencyKey: 'refund:2' });
  add({ idempotencyKey: 'workout-credit:3', createdAt: new Date('2026-11-06T13:00:00Z') }); // after "now"
  const out = await service.markRewardsRevealedService(1, { now: NOW });
  assert.equal(out.revealed, 2);
  assert.equal(rows[2].revealedAt, null);
});

test('one person can never reveal another person\'s credits', async () => {
  reset();
  const theirs = add({ userId: 2, idempotencyKey: 'workout-credit:7' });
  const out = await service.markRewardsRevealedService(1, { ids: [theirs.id], now: NOW });
  assert.equal(out.revealed, 0);
  assert.equal(theirs.revealedAt, null);
  const all = await service.markRewardsRevealedService(1, { now: NOW });
  assert.equal(all.revealed, 0);
  assert.equal(theirs.revealedAt, null);
});

test('non-integer ids are ignored rather than matched', async () => {
  reset();
  const a = add({ idempotencyKey: 'workout-credit:1' });
  const out = await service.markRewardsRevealedService(1, { ids: ['1', null, a.id], now: NOW });
  assert.equal(out.revealed, 1);
});
