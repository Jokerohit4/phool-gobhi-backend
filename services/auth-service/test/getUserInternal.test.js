// Covers the linkedGymId fix in getUserInternal (services/booking-service's
// memberCheckIn depends on this field being present here to verify a caller
// is actually linked to the gym they're checking into — it was already on
// the public profile response but missing from this internal one). Run
// with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

let findUniqueImpl = async () => null;
let getUserInternal;

test('setup: mock @prisma/client once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = { findUnique: (...args) => findUniqueImpl(...args) };
        }
      },
      Prisma: {},
    },
  });
  ({ getUserInternal } = await import('../controllers/authController.js'));
  assert.equal(typeof getUserInternal, 'function');
});

test('getUserInternal includes linkedGymId in the response', async () => {
  findUniqueImpl = async ({ where: { id } }) => ({
    id, name: 'Test User', phone: '9990001111', dateOfBirth: null, gender: null,
    fitnessGoals: [], profileImageUrl: null, fcmToken: null, referredByUserId: null,
    linkedGymId: 9,
  });
  const req = { params: { id: '42' } };
  const res = fakeRes();

  await getUserInternal(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linkedGymId, 9, 'linkedGymId must be present so booking-service.memberCheckIn can verify gym linkage');
});

test('getUserInternal returns linkedGymId: null for a user who is not linked to any gym', async () => {
  findUniqueImpl = async ({ where: { id } }) => ({
    id, name: 'Test User', phone: '9990001111', dateOfBirth: null, gender: null,
    fitnessGoals: [], profileImageUrl: null, fcmToken: null, referredByUserId: null,
    linkedGymId: null,
  });
  const req = { params: { id: '42' } };
  const res = fakeRes();

  await getUserInternal(req, res);

  assert.equal(res.body.linkedGymId, null);
});

test('getUserInternal returns 404 when the user does not exist', async () => {
  findUniqueImpl = async () => null;
  const req = { params: { id: '999' } };
  const res = fakeRes();

  await getUserInternal(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'User not found');
});

test('getUserInternal returns 500 on an unexpected DB error', async () => {
  findUniqueImpl = async () => { throw new Error('connection lost'); };
  const req = { params: { id: '42' } };
  const res = fakeRes();

  await getUserInternal(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'connection lost');
});
