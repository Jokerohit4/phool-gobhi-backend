// retryOwedPayouts - the hourly settlement sweep's partner-payout half. A
// completion flips the booking to `completed` before the wallet credit; if that
// credit failed it was only logged, and the sweep's own autoComplete pass scans
// only `started` rows, so the payout was never retried. Same mock convention as
// autoComplete.test.js: Prisma/axios are small in-memory fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rows = new Map();
const posts = [];
let creditFails = false;
let gymLookupFails = false;

const matches = (b, where) => {
  if (where.status != null && b.status !== where.status) return false;
  if (where.payoutCreditedAt === null && b.payoutCreditedAt != null) return false;
  if (where.payoutAmount && where.payoutAmount.not === null && b.payoutAmount == null) return false;
  return true;
};

const fakePrisma = {
  booking: {
    findMany: async ({ where }) => [...rows.values()].filter((b) => matches(b, where)),
    update: async ({ where, data }) => {
      const b = rows.get(where.id);
      Object.assign(b, data);
      return { ...b };
    },
  },
};

let retryOwedPayouts;

const booking = (id, overrides = {}) => ({
  id,
  gymId: 7,
  amount: 200,
  partnerShare: 170,
  subscriptionId: null,
  isAttendanceSaas: false,
  status: 'completed',
  payoutAmount: 170,
  payoutCreditedAt: null,
  ...overrides,
});

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class { constructor() { return fakePrisma; } }, Prisma: {} },
  });
  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url) => {
          if (gymLookupFails) throw new Error('gym-service down');
          return { data: { data: { id: 7, partnerId: 55, city: 'Gurugram' } }, url };
        },
        post: async (url, body) => {
          if (creditFails) throw new Error('wallet-service down');
          posts.push({ url, body });
          return { data: {} };
        },
      },
    },
  });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  t.mock.module(new URL('../utils/notifyPartner.js', import.meta.url).href, {
    exports: { notifyPartner: async () => {}, sendPartnerPush: async () => true },
  });
  t.mock.module(new URL('../utils/notifyCustomer.js', import.meta.url).href, {
    exports: { notifyCustomer: async () => {} },
  });
  ({ retryOwedPayouts } = await import('../services/bookingService.js'));
  assert.equal(typeof retryOwedPayouts, 'function');
});

test('retries a completed-but-unpaid payout, credits it once, and stamps it', async () => {
  rows.clear();
  posts.length = 0;
  creditFails = false;
  rows.set(1, booking(1));

  const result = await retryOwedPayouts();

  assert.equal(result.owed, 1);
  assert.equal(result.paid, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.endsWith('/55/credit'), true);
  assert.equal(posts[0].body.amount, 170);
  assert.equal(posts[0].body.idempotencyKey, 'booking-payout-1');
  assert.ok(rows.get(1).payoutCreditedAt instanceof Date);

  // An already-credited payout is never picked up again.
  posts.length = 0;
  const again = await retryOwedPayouts();
  assert.equal(again.owed, 0);
  assert.equal(posts.length, 0);
});

test('skips rows that are settled, unowed, or not completed', async () => {
  rows.clear();
  posts.length = 0;
  creditFails = false;
  rows.set(2, booking(2, { payoutCreditedAt: new Date() }));      // already paid
  rows.set(3, booking(3, { payoutAmount: null }));               // nothing owed
  rows.set(4, booking(4, { status: 'cancelled' }));              // wrong status
  rows.set(5, booking(5));                                       // the only real one

  const result = await retryOwedPayouts();
  assert.equal(result.owed, 1);
  assert.equal(result.paid, 1);
  assert.deepEqual(posts.map((p) => p.body.idempotencyKey), ['booking-payout-5']);
});

test('a failed credit leaves the payout owed for the next run', async () => {
  rows.clear();
  posts.length = 0;
  creditFails = true;
  rows.set(6, booking(6));
  try {
    const result = await retryOwedPayouts();
    assert.equal(result.owed, 1);
    assert.equal(result.paid, 0);
    assert.equal(rows.get(6).payoutCreditedAt, null);
  } finally {
    creditFails = false;
  }
});

test('a gym lookup failure leaves the payout for the next run', async () => {
  rows.clear();
  posts.length = 0;
  gymLookupFails = true;
  rows.set(7, booking(7));
  try {
    const result = await retryOwedPayouts();
    assert.equal(result.owed, 1);
    assert.equal(result.paid, 0);
    assert.equal(posts.length, 0);
    assert.equal(rows.get(7).payoutCreditedAt, null);
  } finally {
    gymLookupFails = false;
  }
});
