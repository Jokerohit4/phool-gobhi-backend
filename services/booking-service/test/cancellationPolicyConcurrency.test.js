// Optimistic concurrency (expectedUpdatedAt) on PUT /cancellation-policy.
// Stateful prisma mock with a real compare-and-set updateMany. Run with:
//   node --experimental-test-module-mocks --test test/cancellationPolicyConcurrency.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const T0 = new Date('2026-10-01T10:00:00.000Z');
const TIERS_A = [{ maxHoursNotice: null, blocked: false, refundRate: 1 }];
const TIERS_B = [{ maxHoursNotice: null, blocked: false, refundRate: 0.5 }];
const TIERS_C = [{ maxHoursNotice: null, blocked: false, refundRate: 0.25 }];

let row = null;
let counts = { upsert: 0, updateMany: 0 };

let service, controller;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.cancellationPolicySetting = {
            findUnique: async () => (row ? { ...row } : null),
            upsert: async ({ create, update }) => {
              counts.upsert++;
              row = row ? { ...row, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() };
              return { ...row };
            },
            updateMany: async ({ where, data }) => {
              counts.updateMany++;
              if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
              row = { ...row, ...data };
              return { count: 1 };
            },
          };
        }
      },
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    },
  });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) } } });
  for (const [f, exp] of Object.entries({
    notifyPartner: { notifyPartner: async () => {}, sendPartnerPush: async () => true, resolvePartnerFcmToken: async () => null },
    notifyCustomer: { notifyCustomer: async () => {} },
    notifyChallengeService: { recordAttendanceEvent: async () => {} },
    notifyHealthService: { recordAttendanceForWorkout: async () => {} },
    analytics: { track: () => {} },
    googleIdToken: { googleIdTokenHeader: async () => ({}) },
  })) t.mock.module(new URL(`../utils/${f}.js`, import.meta.url).href, { exports: exp });
  service = await import('../services/bookingService.js');
  controller = await import('../controllers/bookingController.js');
});

function reset() {
  row = { id: 1, tiers: TIERS_A, updatedAt: T0 };
  counts = { upsert: 0, updateMany: 0 };
  service.clearCancellationPolicyCache();
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const put = async (body) => {
  const res = fakeRes();
  await controller.updateCancellationPolicy({ body, userId: 9 }, res);
  return res;
};

test('GET exposes updatedAt', async () => {
  reset();
  assert.equal((await service.getCancellationPolicy()).updatedAt.getTime(), T0.getTime());
});

test('matching expectedUpdatedAt: writes, returns the new updatedAt', async () => {
  reset();
  const res = await put({ tiers: TIERS_B, expectedUpdatedAt: T0.toISOString() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.tiers, TIERS_B);
  assert.ok(res.body.data.updatedAt.getTime() > T0.getTime());
  assert.deepEqual(row.tiers, TIERS_B);
});

test('stale expectedUpdatedAt: 409 CONFIG_CONFLICT, nothing written', async () => {
  reset();
  const res = await put({ tiers: TIERS_B, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: 'This setting was changed by someone else. Reload and try again.',
    errorCode: 'CONFIG_CONFLICT',
    currentUpdatedAt: T0.toISOString(),
  });
  assert.deepEqual(row.tiers, TIERS_A);
  assert.equal(counts.upsert, 0);
});

test('absent expectedUpdatedAt: unchanged behaviour (plain upsert)', async () => {
  reset();
  const res = await put({ tiers: TIERS_B });
  assert.equal(res.statusCode, 200);
  assert.equal(counts.upsert, 1);
  assert.equal(counts.updateMany, 0);
  assert.deepEqual(row.tiers, TIERS_B);
});

test('validation errors still return 400 with the same body', async () => {
  reset();
  const res = await put({ tiers: [], expectedUpdatedAt: T0.toISOString() });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'tiers must be a non-empty array' });
});

test('concurrent double save from one page load: second conflicts', async () => {
  reset();
  const [a, b] = await Promise.all([
    put({ tiers: TIERS_B, expectedUpdatedAt: T0.toISOString() }),
    put({ tiers: TIERS_C, expectedUpdatedAt: T0.toISOString() }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.deepEqual(row.tiers, a.statusCode === 200 ? TIERS_B : TIERS_C);
});
