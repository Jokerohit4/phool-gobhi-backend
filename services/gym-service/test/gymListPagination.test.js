// GET /api/gyms pagination: default unchanged, optional limit/offset, hard cap.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let rows = [];
let listGyms, MAX_GYM_LIST_LIMIT;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.gym = { findMany: async () => rows.map((r) => ({ ...r })) };
        }
      },
      Prisma: {},
    },
  });
  ({ listGyms, MAX_GYM_LIST_LIMIT } = await import('../services/gymService.js'));
});

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `g${i}`, amenities: [], images: [] }));

test('default response is unchanged for ordinary list sizes', async () => {
  rows = mk(50);
  const out = await listGyms({});
  assert.equal(out.length, 50);
});

test('limit and offset page through the list', async () => {
  rows = mk(50);
  const page = await listGyms({ limit: 10, offset: 5 });
  assert.deepEqual(page.map((g) => g.id), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('hard cap applies with and without limit', async () => {
  rows = mk(MAX_GYM_LIST_LIMIT + 200);
  assert.equal((await listGyms({})).length, MAX_GYM_LIST_LIMIT);
  assert.equal((await listGyms({ limit: 999999 })).length, MAX_GYM_LIST_LIMIT);
});
