// Two customer-facing/reporting shapes that leaked internals or dropped rows:
//   1. getCustomerBookings spread the raw Booking row, leaking the platform/
//      partner commercial split (commissionPct, partnerShare, walletTxId) and
//      who verified attendance.
//   2. computeAttendanceHeatmap derived its window from Date#toISOString (the
//      UTC day), so after 18:30 IST "today" was still yesterday and a slot
//      booked for today fell outside the grid.
// Same mock-once-per-file convention as bookingService.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const GYM = { id: 10, partnerId: 20, name: 'Iron Temple', address: 'A', city: 'Gurugram', images: [{ url: 'x' }] };
const CUSTOMER = 1;
const TODAY_IST = '2026-09-14';

let bookingRows = new Map();
let groupByRows = [];
let groupByArgs = [];

const fakePrisma = {
  booking: {
    findMany: async ({ where }) => [...bookingRows.values()].filter((r) => r.customerId === where.customerId),
    groupBy: async (args) => {
      groupByArgs.push(args);
      return groupByRows;
    },
  },
};

let getCustomerBookings, getGymAttendanceHeatmap;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class { constructor() { return fakePrisma; } }, Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } } },
  });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: { data: GYM } }), post: async () => ({ data: {} }) } } });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  t.mock.module(new URL('../utils/notifyPartner.js', import.meta.url).href, {
    exports: { notifyPartner: async () => {}, sendPartnerPush: async () => true, resolvePartnerFcmToken: async () => null },
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
      formatSlotTime: (s) => s,
      shiftedSlotForNow: () => ({ newStartTime: '10:00', newEndTime: '11:00' }),
      IST_OFFSET_MS: (5 * 60 + 30) * 60000,
      getDayOfWeek: (date) => {
        const [y, m, d] = date.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      },
    },
  });
  t.mock.module(new URL('../utils/qrToken.js', import.meta.url).href, {
    exports: { signQrToken: (bookingId, gymId) => `qr.${bookingId}.${gymId}.signed`, verifyQrToken: () => ({ valid: true }) },
  });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: GYM }) });

  ({ getCustomerBookings, getGymAttendanceHeatmap } = await import('../services/bookingService.js'));
  assert.equal(typeof getCustomerBookings, 'function');
});

test('getCustomerBookings: strips the platform/partner commercial split and is never stale-pending', async () => {
  bookingRows = new Map([[1, {
    id: 1, customerId: CUSTOMER, gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    amount: 500, commissionPct: 20, partnerShare: 400, walletTxId: 77,
    payoutAmount: 400, payoutCreditedAt: new Date(),
    status: 'completed', attendedAt: new Date(),
    attendanceVerifiedBy: 20, attendanceOverrideReason: 'phone dead', subscriptionId: null, isAttendanceSaas: false,
    classId: null, checkinRequested: false, locationVerified: true, slotShiftWarning: false,
    cancellationReason: null, nextVisitIntent: null, createdAt: new Date(), updatedAt: new Date(),
  }]]);

  const [b] = await getCustomerBookings(CUSTOMER);

  assert.equal(b.id, 1);
  assert.equal(b.amount, 500, 'the customer still sees what they paid');
  assert.equal(b.commissionPct, undefined, 'platform take-rate is not the customer\'s business');
  assert.equal(b.partnerShare, undefined, 'what the gym keeps is not the customer\'s business');
  assert.equal(b.walletTxId, undefined);
  assert.equal(b.payoutAmount, undefined);
  assert.equal(b.payoutCreditedAt, undefined);
  assert.equal(b.attendanceOverrideReason, undefined);
  assert.equal(b.attendanceVerifiedBy, undefined);
  assert.equal(b.qrToken, 'qr.1.10.signed');
  assert.equal(b.gym.name, 'Iron Temple');
});

test('attendance heatmap window is bounded by IST calendar days', async () => {
  groupByRows = [{ date: TODAY_IST, startTime: '06:00', _count: 3 }];
  groupByArgs = [];

  const result = await getGymAttendanceHeatmap(GYM.id, GYM.partnerId, 30);

  const where = groupByArgs[0].where;
  assert.equal(where.date.lte, TODAY_IST, 'upper bound is today-in-IST, not the UTC day');
  assert.equal(where.date.gte, '2026-08-15', '30 IST calendar days back from 2026-09-14');
  assert.deepEqual(result.cells, [{ date: TODAY_IST, hour: 6, count: 3 }]);
});
