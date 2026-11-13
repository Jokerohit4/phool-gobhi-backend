// Coach-journey B3: referral migration. booking-service used to write the
// two referral credits itself via wallet's generic POST /:userId/credit with
// referral-credit-* idempotency keys; since B4 that generic route 400s those
// keys and POST /internal/referrals/credit is the single writer (cap + bonus
// type, one transaction). These tests pin the new call shape and that the
// old one is gone. Entry point: completeBooking (first completed booking
// trigger). Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const GYM = { id: 10, partnerId: 20, isActive: true, isApproved: true, city: 'Gurugram', commissionPct: 20, sessionPrice: 500 };
const CUSTOMER = 1;
const PARTNER = 20;
const TODAY_IST = '2026-10-12';
const REFERRER = 77;

const bookingRows = new Map();
let bookingNextId = 100;
const posts = [];       // { url, body }
const gets = [];        // { url }
const trackCalls = [];

// Mutable per-test behaviour.
let profile = { name: 'Referred User', dateOfBirth: '1995-01-01', referredByUserId: REFERRER };
let referralStatus = 'credited';
let referralEndpointFails = false;

function resetFakes() {
  bookingRows.clear();
  bookingNextId = 100;
  posts.length = 0;
  gets.length = 0;
  trackCalls.length = 0;
  profile = { name: 'Referred User', dateOfBirth: '1995-01-01', referredByUserId: REFERRER };
  referralStatus = 'credited';
  referralEndpointFails = false;
}

function makeBooking(overrides) {
  return {
    id: bookingNextId++,
    customerId: CUSTOMER,
    gymId: GYM.id,
    date: TODAY_IST,
    startTime: '10:00',
    endTime: '11:00',
    amount: 500,
    commissionPct: 20,
    partnerShare: 400,
    status: 'started',
    subscriptionId: null,
    isAttendanceSaas: false,
    classId: null,
    attendedAt: new Date(),
    attendanceMethod: 'qr_scan',
    checkinRequested: false,
    locationVerified: null,
    slotShiftWarning: false,
    cancellationReason: null,
    nextVisitIntent: null,
    walletTxId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

let completeBooking;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findUnique: async ({ where: { id } }) => bookingRows.get(id) ?? null,
            // The referral block's "is this the first completed booking"
            // check. hasPriorVisitAtGym also lands here with a gymId
            // filter — not under test, so return null for those.
            findFirst: async ({ where }) => {
              if (where.gymId !== undefined) return null;
              const completed = [...bookingRows.values()]
                .filter((r) => r.customerId === where.customerId && r.status === 'completed')
                .sort((a, b) => a.id - b.id);
              return completed.length ? { id: completed[0].id } : null;
            },
            findMany: async () => [],
            count: async () => 0,
            update: async ({ where: { id }, data }) => {
              const row = bookingRows.get(id);
              Object.assign(row, data);
              return row;
            },
            updateMany: async ({ where, data }) => {
              let count = 0;
              for (const row of bookingRows.values()) {
                if (row.id !== where.id) continue;
                if (where.status && where.status.in && !where.status.in.includes(row.status)) continue;
                Object.assign(row, data);
                count++;
              }
              return { count };
            },
            groupBy: async () => [],
          };
          this.memberAttendance = {
            findFirst: async () => null,
            findMany: async () => [],
            groupBy: async () => [],
          };
          this.independentCheckIn = {
            findFirst: async () => null,
            findMany: async () => [],
            groupBy: async () => [],
          };
          this.cancellationPolicySetting = { findUnique: async () => null };
          this.attendanceWarning = { create: async ({ data }) => data };
          this.$transaction = async (fn) => fn(this);
        }
      },
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    },
  });

  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url, _opts) => {
          gets.push({ url });
          if (url.includes('auth-service') || url.includes('/internal/users')) {
            return { data: profile };
          }
          if (url.includes(`/internal/${GYM.id}`)) return { data: { data: GYM } };
          if (url.includes('wallet-service')) return { data: { data: null } };
          throw new Error(`unexpected axios.get: ${url}`);
        },
        post: async (url, body, _opts) => {
          posts.push({ url, body });
          if (url.endsWith('/internal/referrals/credit')) {
            if (referralEndpointFails) throw new Error('wallet referral endpoint down');
            return { data: { data: { status: referralStatus } } };
          }
          if (url.includes('/credit')) return { data: { data: { success: true } } };
          return { data: {} };
        },
      },
    },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  t.mock.module(new URL('../utils/notifyPartner.js', import.meta.url).href, {
    exports: {
      notifyPartner: async () => {},
      sendPartnerPush: async () => true,
      resolvePartnerFcmToken: async () => null,
    },
  });

  t.mock.module(new URL('../utils/notifyCustomer.js', import.meta.url).href, {
    exports: { notifyCustomer: async () => {} },
  });

  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: { recordAttendanceEvent: async () => {} },
  });

  t.mock.module(new URL('../utils/notifyHealthService.js', import.meta.url).href, {
    exports: { recordAttendanceForWorkout: async () => {} },
  });

  t.mock.module(new URL('../utils/analytics.js', import.meta.url).href, {
    exports: { track: (...args) => { trackCalls.push(args); } },
  });

  t.mock.module(new URL('../utils/slotTiming.js', import.meta.url).href, {
    exports: {
      isSlotInPastOrTooSoon: () => false,
      hoursUntilSlot: () => 12,
      todayDateStringIST: () => TODAY_IST,
      isSessionActiveNow: () => true,
      isBeforeSessionWindow: () => false,
      isSessionEnded: () => false,
      sessionEndedBefore: () => false,
      msUntilSlot: () => 0,
      formatSlotTime: (t) => t,
      shiftedSlotForNow: () => ({ newStartTime: '10:00', newEndTime: '11:00' }),
      IST_OFFSET_MS: (5 * 60 + 30) * 60000,
      getDayOfWeek: (date) => {
        const [y, m, d] = date.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      },
    },
  });

  ({ completeBooking } = await import('../services/bookingService.js'));
  assert.equal(typeof completeBooking, 'function');
});

test('first completed booking of a referred customer: one call to /internal/referrals/credit, no generic-credit referral writes', async () => {
  resetFakes();
  const b = makeBooking({ status: 'started', attendedAt: new Date() });
  bookingRows.set(b.id, b);

  const result = await completeBooking(b.id, GYM.id, PARTNER);
  assert.equal(result.status, 'completed');

  const referralCalls = posts.filter((p) => p.url.endsWith('/internal/referrals/credit'));
  assert.equal(referralCalls.length, 1, 'exactly one referral call, owned by wallet');
  assert.deepEqual(referralCalls[0].body, {
    referrerId: REFERRER,
    friendId: CUSTOMER,
    trigger: 'first_booking',
  });

  // The old shape — generic /:userId/credit with a referral-credit-* key —
  // must be gone entirely.
  const oldShape = posts.filter((p) => p.url.includes('/credit')
    && !p.url.endsWith('/internal/referrals/credit')
    && String(p.body?.idempotencyKey || '').startsWith('referral-credit-'));
  assert.equal(oldShape.length, 0, 'no referral keys written through the generic credit route');

  // The partner payout is the only other wallet write.
  const payouts = posts.filter((p) => p.url.endsWith(`/${PARTNER}/credit`));
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].body.idempotencyKey, `booking-payout-${b.id}`);
});

test('referral_credited fires when wallet credits the pair', async () => {
  resetFakes();
  const b = makeBooking({ status: 'started', attendedAt: new Date() });
  bookingRows.set(b.id, b);

  await completeBooking(b.id, GYM.id, PARTNER);

  const fired = trackCalls.filter(([name]) => name === 'referral_credited');
  assert.equal(fired.length, 1);
  assert.equal(fired[0][1], CUSTOMER);
  assert.deepEqual(fired[0][2], { booking_id: b.id, referrer_id: REFERRER });
});

test('an already_credited replay moves no money, so no referral_credited event', async () => {
  resetFakes();
  referralStatus = 'already_credited';
  const b = makeBooking({ status: 'started', attendedAt: new Date() });
  bookingRows.set(b.id, b);

  await completeBooking(b.id, GYM.id, PARTNER);

  assert.equal(posts.filter((p) => p.url.endsWith('/internal/referrals/credit')).length, 1);
  assert.equal(trackCalls.filter(([name]) => name === 'referral_credited').length, 0);
});

test('a capped referral still credits the friend, so the event fires', async () => {
  resetFakes();
  referralStatus = 'capped';
  const b = makeBooking({ status: 'started', attendedAt: new Date() });
  bookingRows.set(b.id, b);

  await completeBooking(b.id, GYM.id, PARTNER);

  assert.equal(trackCalls.filter(([name]) => name === 'referral_credited').length, 1);
});

test('a later completed booking of the same customer never re-fires the referral', async () => {
  resetFakes();
  const first = makeBooking({ status: 'completed', attendedAt: new Date() });
  bookingRows.set(first.id, first);
  const second = makeBooking({ status: 'started', attendedAt: new Date() });
  bookingRows.set(second.id, second);

  await completeBooking(second.id, GYM.id, PARTNER);

  assert.equal(posts.filter((p) => p.url.endsWith('/internal/referrals/credit')).length, 0);
  assert.equal(trackCalls.filter(([name]) => name === 'referral_credited').length, 0);
});

test('a customer with no referrer never triggers the call', async () => {
  resetFakes();
  profile = { name: 'Organic User', dateOfBirth: '1995-01-01' };
  const b = makeBooking({ status: 'started', attendedAt: new Date() });
  bookingRows.set(b.id, b);

  await completeBooking(b.id, GYM.id, PARTNER);

  assert.equal(posts.filter((p) => p.url.endsWith('/internal/referrals/credit')).length, 0);
});

test('the wallet referral endpoint being down never fails the completion', async () => {
  resetFakes();
  referralEndpointFails = true;
  const b = makeBooking({ status: 'started', attendedAt: new Date() });
  bookingRows.set(b.id, b);

  const result = await completeBooking(b.id, GYM.id, PARTNER);
  assert.equal(result.status, 'completed');
  assert.equal(posts.filter((p) => p.url.endsWith('/internal/referrals/credit')).length, 1, 'the call was attempted');
  assert.equal(trackCalls.filter(([name]) => name === 'referral_credited').length, 0);
});
