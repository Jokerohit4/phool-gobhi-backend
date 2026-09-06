// Covers listMyCollectibles/collectCollectible -- the veggie-collectible
// currency is deliberately standalone (no coins, no gyms involved), just a
// per-user set of found ids. Run with:
// node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

let findManyImpl = async () => [];
let upsertImpl = async () => ({});
let listMyCollectibles;
let collectCollectible;

test('setup: mock @prisma/client once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.collectibleFind = {
            findMany: (...args) => findManyImpl(...args),
            upsert: (...args) => upsertImpl(...args),
          };
        }
      },
      Prisma: {},
    },
  });
  ({ listMyCollectibles, collectCollectible } =
    await import('../controllers/authController.js'));
  assert.equal(typeof listMyCollectibles, 'function');
  assert.equal(typeof collectCollectible, 'function');
});

test('listMyCollectibles returns just the ids, scoped to the requesting user', async () => {
  let capturedWhere;
  findManyImpl = async ({ where }) => {
    capturedWhere = where;
    return [{ collectibleId: 'veg_3_4' }, { collectibleId: 'veg_5_1' }];
  };
  const req = { user: { id: 42 } };
  const res = fakeRes();

  await listMyCollectibles(req, res);

  assert.deepEqual(capturedWhere, { userId: 42 });
  assert.deepEqual(res.body.data, ['veg_3_4', 'veg_5_1']);
});

test('listMyCollectibles returns an empty list for a user with no finds', async () => {
  findManyImpl = async () => [];
  const req = { user: { id: 7 } };
  const res = fakeRes();

  await listMyCollectibles(req, res);

  assert.deepEqual(res.body.data, []);
});

test('listMyCollectibles returns 500 on an unexpected DB error', async () => {
  findManyImpl = async () => { throw new Error('connection lost'); };
  const req = { user: { id: 7 } };
  const res = fakeRes();

  await listMyCollectibles(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'connection lost');
});

test('collectCollectible upserts a find for the requesting user', async () => {
  let capturedArgs;
  upsertImpl = async (args) => { capturedArgs = args; return {}; };
  const req = { user: { id: 42 }, params: { collectibleId: 'veg_3_4' } };
  const res = fakeRes();

  await collectCollectible(req, res);

  assert.deepEqual(capturedArgs.where, {
    userId_collectibleId: { userId: 42, collectibleId: 'veg_3_4' },
  });
  assert.deepEqual(capturedArgs.create, { userId: 42, collectibleId: 'veg_3_4' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.collectibleId, 'veg_3_4');
});

test('collectCollectible is idempotent -- collecting an already-found id again still succeeds', async () => {
  upsertImpl = async () => ({}); // upsert's update:{} makes a repeat call a no-op
  const req = { user: { id: 42 }, params: { collectibleId: 'veg_3_4' } };
  const res = fakeRes();

  await collectCollectible(req, res);
  await collectCollectible(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test('collectCollectible returns 400 when collectibleId is missing', async () => {
  const req = { user: { id: 42 }, params: {} };
  const res = fakeRes();

  await collectCollectible(req, res);

  assert.equal(res.statusCode, 400);
});

test('collectCollectible returns 500 on an unexpected DB error', async () => {
  upsertImpl = async () => { throw new Error('connection lost'); };
  const req = { user: { id: 42 }, params: { collectibleId: 'veg_3_4' } };
  const res = fakeRes();

  await collectCollectible(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'connection lost');
});
