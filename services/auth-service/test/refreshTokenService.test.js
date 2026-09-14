// Covers refresh-token rotation (services/refreshTokenService.js): one-time-use
// refresh JWTs with ~10s reuse grace, family revocation on late replay, and
// the atomic claim that stops two concurrent refreshes forking one session.
// This is the security boundary behind the "kill switch", so failure modes must
// be precisely locked down. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.JWT_SECRET = 'test-access-secret';

const NOW_UTC = Date.UTC(2026, 8, 14, 10, 0, 0);
const FAMILY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

let prisma;
let updateCalls = [];
let createCalls = [];
let revokeUpdateCalls = [];

class MockPrismaClient {
  constructor() {
    prisma = this;
    prisma.refreshToken = {
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 }),
      create: async () => ({}),
    };
    prisma.$transaction = async (fn) => fn(prisma);
  }
}

let rotate, issueRefreshFamily, revokeFamily, revokeByToken;

test('setup: mock @prisma/client once, import refreshTokenService once', async (t) => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: MockPrismaClient } });
  ({ rotate, issueRefreshFamily, revokeFamily, revokeByToken } = await import('../services/refreshTokenService.js'));
  assert.equal(typeof rotate, 'function');
});

function signTestToken({ id = 5, jti, familyId, expiresIn = '15m' } = {}) {
  return jwt.sign({ id, jti, familyId }, process.env.JWT_REFRESH_SECRET, { expiresIn });
}

function makeRow({ jti = 'j1', familyId = 'f1', userId = 5, expiresAt = new Date(NOW_UTC + FAMILY_LIFETIME_MS), revokedAt = null, usedAt = null, replacedByJti = null } = {}) {
  return { jti, familyId, userId, expiresAt, revokedAt, usedAt, replacedByJti };
}

function wireHappyRotation() {
  updateCalls = [];
  createCalls = [];
  prisma.refreshToken.updateMany = async (args) => {
    updateCalls.push(args);
    return { count: 1 };
  };
  prisma.refreshToken.create = async (args) => { createCalls.push(args); return {}; };
}

async function assertThrows(thenable, desired) {
  try {
    await thenable;
    assert.fail('expected the call to throw');
  } catch (err) {
    assert.equal(err.status, desired.status);
    assert.equal(err.errorCode, desired.errorCode);
    return err;
  }
}

// ---- rotate(): rejection paths ---------------------------------------------

test('rotate: rejects a token with a bad signature as E109 (no DB touch)', async (t) => {
  let queried = false;
  prisma.refreshToken.findUnique = async () => { queried = true; };
  await assertThrows(rotate('garbage.token.value'), { status: 403, errorCode: 'E109' });
  assert.equal(queried, false);
});

test('rotate: rejects a pre-rotation token that has no jti/familyId as E109', (t) => {
  const token = jwt.sign({ id: 5 }, process.env.JWT_REFRESH_SECRET, { expiresIn: '15m' });
  return assertThrows(rotate(token), { status: 403, errorCode: 'E109' });
});

test('rotate: rejects a valid token with no matching DB row (E109)', async (t) => {
  prisma.refreshToken.findUnique = async () => null;
  const token = signTestToken({ jti: 'ghost', familyId: 'ghost-family' });
  await assertThrows(rotate(token), { status: 403, errorCode: 'E109' });
});

test('rotate: rejects a revoked token as E120 (session revoked)', async (t) => {
  prisma.refreshToken.findUnique = async () => makeRow({ revokedAt: new Date(NOW_UTC - 1000) });
  const token = signTestToken({ jti: 'j1', familyId: 'f1' });
  await assertThrows(rotate(token), { status: 403, errorCode: 'E120' });
});

test('rotate: rejects a family whose absolute expiry already passed (E109)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  prisma.refreshToken.findUnique = async () => makeRow({ expiresAt: new Date(NOW_UTC - 1) });
  const token = signTestToken({ jti: 'j1', familyId: 'f1' });
  await assertThrows(rotate(token), { status: 403, errorCode: 'E109' });
});

// ---- rotate(): happy path ---------------------------------------------------

test('rotate: claims the token and issues a successor in the same family', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const row = makeRow();
  prisma.refreshToken.findUnique = async ({ where }) => (where.jti === 'j1' ? row : null);
  wireHappyRotation();

  const out = await rotate(signTestToken({ jti: 'j1', familyId: 'f1' }));

  assert.equal(out.userId, 5);
  const successor = jwt.verify(out.refreshToken, process.env.JWT_REFRESH_SECRET);
  assert.equal(successor.familyId, 'f1');
  assert.notEqual(successor.jti, 'j1', 'the successor must carry a brand-new jti');

  // The atomic claim: updateMany conditioned on usedAt null, then create.
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].where, { jti: 'j1', usedAt: null });
  assert.ok(updateCalls[0].data.usedAt);
  assert.equal(updateCalls[0].data.replacedByJti, successor.jti);

  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].data.jti, successor.jti);
  assert.equal(createCalls[0].data.familyId, 'f1');
  assert.equal(createCalls[0].data.userId, 5);
  assert.equal(createCalls[0].data.expiresAt.getTime(), row.expiresAt.getTime());
});

// ---- rotate(): reuse within grace (benign race) ------------------------------

test('rotate: a token reused within the grace window gets the same successor back', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const successorJti = 's1';
  prisma.refreshToken.findUnique = async ({ where }) => {
    if (where.jti === 'j1') return makeRow({ usedAt: new Date(NOW_UTC - 2000), replacedByJti: successorJti });
    if (where.jti === successorJti) return makeRow({ jti: successorJti });
    return null;
  };

  let revokedFamilies = [];
  prisma.refreshToken.updateMany = async (args) => {
    if (args.data && args.data.revokedAt) revokedFamilies.push(args.where.familyId);
    return { count: 1 };
  };

  const out = await rotate(signTestToken({ jti: 'j1', familyId: 'f1' }));
  const payload = jwt.verify(out.refreshToken, process.env.JWT_REFRESH_SECRET);
  assert.equal(payload.jti, successorJti);
  assert.equal(revokedFamilies.length, 0, 'benign race must NOT revoke the family');
});

// ---- rotate(): reuse outside grace (theft signal) ---------------------------

test('rotate: late reuse revokes the whole family and returns E120', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  prisma.refreshToken.findUnique = async ({ where }) =>
    (where.jti === 'j1' ? makeRow({ usedAt: new Date(NOW_UTC - 60_000), replacedByJti: 's1' }) : null);

  let revokedWhere = null;
  prisma.refreshToken.updateMany = async (args) => {
    if (args.data && args.data.revokedAt) revokedWhere = args.where;
    return { count: 1 };
  };

  const err = await assertThrows(rotate(signTestToken({ jti: 'j1', familyId: 'f1' })), { status: 403, errorCode: 'E120' });
  assert.match(err.error, /revoked/);
  assert.deepEqual(revokedWhere, { familyId: 'f1', revokedAt: null });
});

// ---- rotate(): losing the atomic claim --------------------------------------

test('rotate: losing the atomic claim falls back to the reuse path', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const successorJti = 's2';
  createCalls = [];
  prisma.refreshToken.findUnique = async ({ where }) => {
    if (where.jti === 'j1') return makeRow({ usedAt: new Date(NOW_UTC - 3000), replacedByJti: successorJti });
    if (where.jti === successorJti) return makeRow({ jti: successorJti });
    return null;
  };
  prisma.refreshToken.updateMany = async () => ({ count: 0 }); // the loser
  prisma.refreshToken.create = async () => { throw new Error('loser must not create a successor'); };

  const out = await rotate(signTestToken({ jti: 'j1', familyId: 'f1' }));
  const payload = jwt.verify(out.refreshToken, process.env.JWT_REFRESH_SECRET);
  assert.equal(payload.jti, successorJti);
  assert.equal(createCalls.length, 0, 'the loser must not create a second successor');
});

test('rotate: a claim-loser with a missing successor still fails cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  prisma.refreshToken.findUnique = async ({ where }) => {
    if (where.jti === 'j1') return makeRow({ usedAt: new Date(NOW_UTC - 3000), replacedByJti: 'missing' });
    return null; // successor row deleted mid-flight
  };
  prisma.refreshToken.updateMany = async () => ({ count: 0 });
  await assertThrows(rotate(signTestToken({ jti: 'j1', familyId: 'f1' })), { status: 403, errorCode: 'E109' });
});

// ---- issueRefreshFamily -----------------------------------------------------

test('issueRefreshFamily: creates a fresh family row and signs its first token', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  let createArgs;
  prisma.refreshToken.create = async (args) => { createArgs = args; return {}; };

  const token = await issueRefreshFamily(9);
  const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  assert.equal(payload.id, 9);
  assert.ok(payload.jti);
  assert.ok(payload.familyId);

  assert.equal(createArgs.data.userId, 9);
  assert.equal(createArgs.data.jti, payload.jti);
  assert.equal(createArgs.data.familyId, payload.familyId);
  assert.equal(createArgs.data.expiresAt.getTime() - NOW_UTC, FAMILY_LIFETIME_MS);
  assert.equal(createArgs.data.revokedAt, undefined);
});

// ---- revokeFamily -----------------------------------------------------------

test('revokeFamily: revokes only not-yet-revoked rows of the family (idempotent)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  let where = null;
  prisma.refreshToken.updateMany = async (args) => { where = args.where; return { count: 2 }; };
  await revokeFamily('f1');
  assert.deepEqual(where, { familyId: 'f1', revokedAt: null });
});

// ---- revokeByToken (logout) --------------------------------------------------

test('revokeByToken: garbage token is a quiet no-op', async (t) => {
  let updateCallsCount = 0;
  prisma.refreshToken.updateMany = async () => { updateCallsCount += 1; return { count: 0 }; };
  const out = await revokeByToken('not-a-token');
  assert.equal(out, undefined);
  assert.equal(updateCallsCount, 0);
});

test('revokeByToken: a valid token revokes its whole family', async (t) => {
  let revokedFamily = null;
  prisma.refreshToken.updateMany = async (args) => { revokedFamily = args.where.familyId; return { count: 1 }; };
  const token = signTestToken({ jti: 'j9', familyId: 'family-logout' });
  await revokeByToken(token);
  assert.equal(revokedFamily, 'family-logout');
});