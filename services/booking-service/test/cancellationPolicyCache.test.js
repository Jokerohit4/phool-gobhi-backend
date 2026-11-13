// cancelBooking caches the refund-tier policy (15s TTL, single-flight). Run with:
//   node --experimental-test-module-mocks --test test/cancellationPolicyCache.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';
process.env.BOOKING_CACHE_FORCE = '1'; // cache is off under node --test otherwise

const TIERS_A = [
  { maxHoursNotice: 1, blocked: true, refundRate: 0 },
  { maxHoursNotice: 4, blocked: false, refundRate: 0.3 },
  { maxHoursNotice: null, blocked: false, refundRate: 1.0 },
];
const TIERS_B = [
  { maxHoursNotice: 1, blocked: true, refundRate: 0 },
  { maxHoursNotice: 4, blocked: false, refundRate: 0.9 },
  { maxHoursNotice: null, blocked: false, refundRate: 1.0 },
];

let policyRow = null; // null => DEFAULT fallback
let policyReads = 0;
let policyFails = false;
let policyGate = null;
let rows = new Map();
let nextId = 1;
let credits = [];

function booking() {
  const row = {
    id: nextId++, customerId: 1, gymId: 10, date: '2026-09-14', startTime: '10:00', endTime: '11:00',
    amount: 500, status: 'confirmed', subscriptionId: null, classId: null, createdAt: new Date(), updatedAt: new Date(),
  };
  rows.set(row.id, row);
  return row;
}

let cancelBooking, updateCancellationPolicy, getCancellationPolicy, clearCancellationPolicyCache;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findUnique: async ({ where: { id } }) => rows.get(id) ?? null,
            findFirst: async () => null,
            update: async ({ where: { id }, data }) => Object.assign(rows.get(id), data),
            updateMany: async ({ where, data }) => {
              const r = rows.get(where.id);
              if (!r || !where.status.in.includes(r.status)) return { count: 0 };
              Object.assign(r, data);
              return { count: 1 };
            },
          };
          this.cancellationPolicySetting = {
            findUnique: async () => {
              policyReads++;
              if (policyGate) await policyGate;
              if (policyFails) throw new Error('db down');
              return policyRow;
            },
            upsert: async ({ create }) => {
              policyRow = { ...create, updatedAt: new Date() };
              return policyRow;
            },
          };
          this.$transaction = async (fn) => fn(this);
        }
      },
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    },
  });
  t.mock.module('axios', {
    exports: {
      default: {
        get: async () => ({ data: { data: { id: 10, partnerId: 20, city: 'X', commissionPct: 20 }, name: 'U' } }),
        post: async (url, body) => { if (url.includes('/credit')) credits.push(body); return { data: { success: true } }; },
      },
    },
  });
  for (const [f, exp] of Object.entries({
    notifyPartner: { notifyPartner: async () => {}, sendPartnerPush: async () => true, resolvePartnerFcmToken: async () => null },
    notifyCustomer: { notifyCustomer: async () => {} },
    notifyChallengeService: { recordAttendanceEvent: async () => {} },
    notifyHealthService: { recordAttendanceForWorkout: async () => {} },
    analytics: { track: () => {} },
    googleIdToken: { googleIdTokenHeader: async () => ({}) },
  })) t.mock.module(new URL(`../utils/${f}.js`, import.meta.url).href, { exports: exp });
  const real = await import('../utils/slotTiming.js');
  t.mock.module(new URL('../utils/slotTiming.js', import.meta.url).href, {
    exports: { ...real, hoursUntilSlot: () => 3 }, // inside the 1h-4h tier
  });
  ({ cancelBooking, updateCancellationPolicy, getCancellationPolicy, clearCancellationPolicyCache } =
    await import('../services/bookingService.js'));
});

function reset() {
  clearCancellationPolicyCache();
  policyRow = { id: 1, tiers: TIERS_A, updatedAt: new Date() };
  policyReads = 0; policyFails = false; policyGate = null;
  rows = new Map(); credits = [];
}

test('cache hit within TTL: second cancel does not re-read the policy', async () => {
  reset();
  const a = booking(); const b = booking();
  await cancelBooking(a.id, 1);
  await cancelBooking(b.id, 1);
  assert.equal(policyReads, 1);
});

test('refund from the CACHED policy equals the refund from a fresh read', async () => {
  reset();
  const first = await cancelBooking(booking().id, 1); // fresh read, populates cache
  const cached = await cancelBooking(booking().id, 1); // served from cache
  assert.equal(policyReads, 1);
  clearCancellationPolicyCache();
  const fresh = await cancelBooking(booking().id, 1); // fresh again
  assert.equal(policyReads, 2);
  for (const r of [first, cached, fresh]) {
    assert.equal(r.refundRate, 0.3);
    assert.equal(r.refundAmount, 150);
    assert.equal(r.status, 'cancelled');
  }
  assert.deepEqual(credits.map((c) => c.amount), [150, 150, 150]);
});

test('a policy change is visible immediately after the update evicts the cache', async () => {
  reset();
  assert.equal((await cancelBooking(booking().id, 1)).refundRate, 0.3); // cached A
  await updateCancellationPolicy(TIERS_B, 99); // evicts
  const r = await cancelBooking(booking().id, 1);
  assert.equal(r.refundRate, 0.9);
  assert.equal(r.refundAmount, 450);
});

test('without eviction the stale policy would still be served (proves the cache is live)', async () => {
  reset();
  await cancelBooking(booking().id, 1);
  policyRow = { ...policyRow, tiers: TIERS_B }; // out-of-band write, no eviction
  assert.equal((await cancelBooking(booking().id, 1)).refundRate, 0.3);
});

test('an in-flight read that began before a policy write cannot repopulate stale tiers', async () => {
  reset();
  let release; policyGate = new Promise((r) => { release = r; });
  const pending = cancelBooking(booking().id, 1); // reads TIERS_A, blocked
  await new Promise((r) => setImmediate(r));
  await updateCancellationPolicy(TIERS_B, 99); // evict + detach
  release(); policyGate = null;
  await pending;
  assert.equal((await cancelBooking(booking().id, 1)).refundRate, 0.9);
});

test('a failed read is not cached: error surfaces, next cancel retries and succeeds', async () => {
  reset();
  policyFails = true;
  const a = booking();
  await assert.rejects(() => cancelBooking(a.id, 1));
  assert.equal(a.status, 'confirmed', 'no cancellation happened');
  policyFails = false;
  const r = await cancelBooking(a.id, 1);
  assert.equal(r.refundRate, 0.3);
  assert.equal(policyReads, 2);
});

test('single-flight: concurrent cancels share one policy read', async () => {
  reset();
  let release; policyGate = new Promise((r) => { release = r; });
  const ps = [booking(), booking(), booking()].map((b) => cancelBooking(b.id, 1));
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all(ps);
  assert.equal(policyReads, 1);
});

test('GET policy endpoint path stays uncached (admin always sees the stored value)', async () => {
  reset();
  await getCancellationPolicy(); await getCancellationPolicy();
  assert.equal(policyReads, 2);
});
