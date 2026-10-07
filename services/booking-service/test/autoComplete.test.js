// autoCompleteEndedSessions - the hourly sweep that finishes verified sessions
// a partner never tapped "complete" on. Same convention as dailyBriefing.test.js:
// bookingService's heavy deps are mocked once so the import works. Prisma and
// axios are small in-memory fakes so the sweep's claim + payout path runs for
// real against them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const IST = 5.5 * 3600000;
// 2026-10-08 20:00 IST
const NOW = Date.UTC(2026, 9, 8, 20, 0) - IST;

const rows = new Map();
const posts = [];
const fakePrisma = {
  booking: {
    findMany: async ({ where }) => [...rows.values()].filter(
      (b) => b.status === where.status && b.attendedAt != null && b.date <= where.date.lte,
    ),
    updateMany: async ({ where, data }) => {
      const b = rows.get(where.id);
      if (!b || b.status !== where.status) return { count: 0 };
      Object.assign(b, data);
      return { count: 1 };
    },
    findUnique: async ({ where }) => ({ ...rows.get(where.id) }),
    // Referral check: never this customer's first completed booking.
    findFirst: async () => ({ id: -1 }),
  },
};

let isDueForAutoComplete;
let autoCompleteEndedSessions;
let gymLookupFails = false;

const booking = (id, overrides = {}) => ({
  id,
  customerId: 100 + id,
  gymId: 7,
  date: '2026-10-08',
  startTime: '17:00',
  endTime: '18:00',
  amount: 200,
  partnerShare: 170,
  commissionPct: 15,
  subscriptionId: null,
  isAttendanceSaas: false,
  status: 'started',
  attendedAt: new Date(NOW - 3 * 3600000),
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
        post: async (url, body) => { posts.push({ url, body }); return { data: {} }; },
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
  ({ isDueForAutoComplete, autoCompleteEndedSessions } = await import('../services/bookingService.js'));
  assert.equal(typeof autoCompleteEndedSessions, 'function');
});

test('due: a verified session whose slot ended over an hour ago', () => {
  assert.equal(isDueForAutoComplete(booking(1), NOW), true);
});

test('not due: still inside the grace hour after the slot', () => {
  assert.equal(isDueForAutoComplete(booking(1, { startTime: '18:00', endTime: '19:30' }), NOW), false);
});

test('not due: never checked in - a no-show is not paid out', () => {
  assert.equal(isDueForAutoComplete(booking(1, { status: 'confirmed', attendedAt: null }), NOW), false);
});

test('due: a verified session from an earlier day the partner forgot', () => {
  assert.equal(isDueForAutoComplete(booking(1, { date: '2026-10-05' }), NOW), true);
});

test('the sweep completes due sessions, pays each once with an idempotency key, and leaves the rest', async () => {
  rows.clear();
  posts.length = 0;
  rows.set(1, booking(1));
  rows.set(2, booking(2, { date: '2026-10-06' }));
  rows.set(3, booking(3, { startTime: '19:00', endTime: '20:00' })); // just ended, inside grace
  rows.set(4, booking(4, { status: 'confirmed', attendedAt: null })); // no-show

  const result = await autoCompleteEndedSessions({ nowMs: NOW });

  assert.equal(result.completed, 2);
  assert.deepEqual(result.failures, []);
  assert.equal(rows.get(1).status, 'completed');
  assert.equal(rows.get(2).status, 'completed');
  assert.equal(rows.get(3).status, 'started');
  assert.equal(rows.get(4).status, 'confirmed');

  const payouts = posts.filter((p) => p.url.endsWith('/55/credit'));
  assert.deepEqual(payouts.map((p) => p.body.idempotencyKey).sort(), ['booking-payout-1', 'booking-payout-2']);
  assert.equal(payouts[0].body.amount, 170);

  // A second run finds nothing left to do and pays nobody again.
  posts.length = 0;
  const again = await autoCompleteEndedSessions({ nowMs: NOW });
  assert.equal(again.completed, 0);
  assert.equal(posts.length, 0);
});

test('a gym lookup failure is reported per booking and leaves it for the next run', async () => {
  rows.clear();
  posts.length = 0;
  rows.set(5, booking(5));
  gymLookupFails = true;
  try {
    const result = await autoCompleteEndedSessions({ nowMs: NOW });
    assert.equal(result.completed, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(rows.get(5).status, 'started');
  } finally {
    gymLookupFails = false;
  }
});
