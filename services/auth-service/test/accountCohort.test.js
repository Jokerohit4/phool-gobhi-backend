// Staff-assigned account cohort: validation, not-found, no-op on unchanged
// value, and bulk reporting of unknown ids.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let users = [];
let svc;

test('setup: mock prisma, import authService once', async (t) => {
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            findUnique: async ({ where }) => users.find((u) => u.id === where.id) ?? null,
            findMany: async ({ where, take }) => {
              let r = users;
              if (where.id?.in) r = r.filter((u) => where.id.in.includes(u.id));
              if (where.id?.gt) r = r.filter((u) => u.id > where.id.gt);
              if (where.accountCohort?.not) r = r.filter((u) => u.accountCohort !== where.accountCohort.not);
              else if (where.accountCohort) r = r.filter((u) => u.accountCohort === where.accountCohort);
              return take ? r.slice(0, take) : r;
            },
            groupBy: async () => {
              const m = {};
              users.forEach((u) => { m[u.accountCohort] = (m[u.accountCohort] || 0) + 1; });
              return Object.entries(m).map(([accountCohort, n]) => ({ accountCohort, _count: { _all: n } }));
            },
            update: async ({ where, data }) => {
              const u = users.find((x) => x.id === where.id);
              Object.assign(u, data);
              return u;
            },
            updateMany: async ({ where, data }) => {
              const hit = users.filter((u) => where.id.in.includes(u.id));
              hit.forEach((u) => Object.assign(u, data));
              return { count: hit.length };
            },
          };
        }
      },
      Prisma: {},
    },
  });
  svc = await import('../services/authService.js');
});

const reset = () => {
  users = [
    { id: 1, name: 'a', role: 'customer', accountCohort: 'UNKNOWN_USERS' },
    { id: 2, name: 'b', role: 'customer', accountCohort: 'UNKNOWN_USERS' },
  ];
};

test('sets a valid cohort', async () => {
  reset();
  const r = await svc.setAccountCohortService('1', 'FRIENDS_AND_FAMILY', 9);
  assert.equal(r.accountCohort, 'FRIENDS_AND_FAMILY');
});

test('rejects an invalid cohort and bad ids', async () => {
  reset();
  await assert.rejects(svc.setAccountCohortService(1, 'VIP', 9), { status: 400 });
  await assert.rejects(svc.setAccountCohortService('abc', 'TESTING_ACCOUNTS', 9), { status: 400 });
  await assert.rejects(svc.setAccountCohortService(99, 'TESTING_ACCOUNTS', 9), { status: 404 });
});

test('bulk updates found ids and reports the rest', async () => {
  reset();
  const r = await svc.setAccountCohortBulkService([1, 2, 2, 77], 'TESTING_ACCOUNTS', 9);
  assert.deepEqual(r, { updated: 2, notFound: [77] });
  assert.ok(users.every((u) => u.accountCohort === 'TESTING_ACCOUNTS'));
});

test('bulk validates input', async () => {
  reset();
  await assert.rejects(svc.setAccountCohortBulkService([], 'TESTING_ACCOUNTS', 9), { status: 400 });
  await assert.rejects(svc.setAccountCohortBulkService([1, 'x'], 'TESTING_ACCOUNTS', 9), { status: 400 });
  await assert.rejects(svc.setAccountCohortBulkService([1], 'NOPE', 9), { status: 400 });
  await assert.rejects(
    svc.setAccountCohortBulkService(Array.from({ length: 501 }, (_, i) => i + 1), 'TESTING_ACCOUNTS', 9),
    { status: 400 },
  );
});

test('lists by cohort with counts and cursor paging', async () => {
  reset();
  users.push({ id: 3, name: 'c', role: 'customer', accountCohort: 'TESTING_ACCOUNTS' });
  const all = await svc.listUsersByCohortService({ limit: '2' });
  assert.equal(all.users.length, 2);
  assert.equal(all.nextCursor, 2);
  assert.deepEqual(all.counts, { FRIENDS_AND_FAMILY: 0, GENERATED_ACCOUNTS: 0, TESTING_ACCOUNTS: 1, UNKNOWN_USERS: 2 });
  const next = await svc.listUsersByCohortService({ limit: '2', cursor: '2' });
  assert.deepEqual(next.users.map((u) => u.id), [3]);
  assert.equal(next.nextCursor, null);
  const only = await svc.listUsersByCohortService({ cohort: 'TESTING_ACCOUNTS' });
  assert.deepEqual(only.users.map((u) => u.id), [3]);
  await assert.rejects(svc.listUsersByCohortService({ cohort: 'VIP' }), { status: 400 });
  await assert.rejects(svc.listUsersByCohortService({ cursor: 'x' }), { status: 400 });
});

test('non-default cohort ids are grouped by cohort as strings, UNKNOWN_USERS left out', async () => {
  reset();
  users.push(
    { id: 3, name: 'c', role: 'customer', accountCohort: 'TESTING_ACCOUNTS' },
    { id: 4, name: 'd', role: 'customer', accountCohort: 'FRIENDS_AND_FAMILY' },
  );
  const r = await svc.listNonDefaultCohortIdsService();
  assert.deepEqual(r, { FRIENDS_AND_FAMILY: ['4'], GENERATED_ACCOUNTS: [], TESTING_ACCOUNTS: ['3'] });
});
