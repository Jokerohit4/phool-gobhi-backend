// Covers core booking lifecycle: createBooking, cancelBooking,
// completeBooking, confirmBooking, getSlotCounts. Run with:
//   node --experimental-test-module-mocks --test
//
// Same mock-once-per-file convention as memberCheckIn.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const GYM = {
  id: 10, partnerId: 20, isActive: true, isApproved: true,
  city: 'Gurugram', commissionPct: 20, capacity: 10,
  sessionPrice: 500, resolvedSlotPrice: 500,
};
const CUSTOMER = 1;
const PARTNER = 20;
const OTHER_PARTNER = 99;
const TODAY_IST = '2026-09-14';

let bookingNextId = 100;
const bookingRows = new Map();
let walletDebitCalls = [];
let walletCreditCalls = [];
let notifyCustomerCalls = [];
let notifyPartnerCalls = [];
let trackCalls = [];
let gymOverride = null;
let gymLookupThrows = false;
let profileLookupThrows = false;
let profileIncomplete = false;
let walletDebitFails = false;

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
    status: 'confirmed',
    subscriptionId: null,
    isAttendanceSaas: false,
    classId: null,
    attendedAt: null,
    attendanceMethod: null,
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

function resetFakes() {
  bookingNextId = 100;
  bookingRows.clear();
  walletDebitCalls = [];
  walletCreditCalls = [];
  notifyCustomerCalls = [];
  notifyPartnerCalls = [];
  trackCalls = [];
  gymOverride = null;
  gymLookupThrows = false;
  profileLookupThrows = false;
  profileIncomplete = false;
  walletDebitFails = false;
}

let createBooking, cancelBooking, completeBooking, confirmBooking, getSlotCounts;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findUnique: async ({ where: { id } }) => bookingRows.get(id) ?? null,
            findFirst: async ({ where }) => {
              for (const row of bookingRows.values()) {
                if (where.status && where.status.not && row.status === where.status.not) continue;
                if (where.customerId && row.customerId !== where.customerId) continue;
                if (where.gymId && row.gymId !== where.gymId) continue;
                if (where.date && row.date !== where.date) continue;
                if (where.startTime && row.startTime !== where.startTime) continue;
                if (where.status && typeof where.status === 'string' && row.status !== where.status) continue;
                if (where.status && where.status.in && !where.status.in.includes(row.status)) continue;
                if (where.subscriptionId !== undefined && row.subscriptionId !== where.subscriptionId) continue;
                if (where.classId !== undefined && row.classId !== where.classId) continue;
                return row;
              }
              return null;
            },
            findMany: async ({ where }) => {
              let results = [...bookingRows.values()];
              if (where.gymId !== undefined) results = results.filter(r => r.gymId === where.gymId);
              if (where.date !== undefined) results = results.filter(r => r.date === where.date);
              if (where.classId !== undefined && where.classId === null) results = results.filter(r => r.classId === null);
              if (where.status && where.status.not) results = results.filter(r => r.status !== where.status.not);
              return results;
            },
            count: async ({ where }) => {
              let results = [...bookingRows.values()];
              if (where.gymId !== undefined) results = results.filter(r => r.gymId === where.gymId);
              if (where.date !== undefined) results = results.filter(r => r.date === where.date);
              if (where.status !== undefined) results = results.filter(r => r.status === where.status);
              return results.length;
            },
            create: async ({ data }) => {
              const row = { id: bookingNextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
              bookingRows.set(row.id, row);
              return row;
            },
            update: async ({ where: { id }, data }) => {
              const row = bookingRows.get(id);
              if (!row) throw new Error('not found');
              Object.assign(row, data);
              return row;
            },
            updateMany: async ({ where, data }) => {
              let count = 0;
              for (const row of bookingRows.values()) {
                let match = true;
                if (where.id !== undefined && row.id !== where.id) match = false;
                if (where.status && typeof where.status === 'string' && row.status !== where.status) match = false;
                if (where.status && where.status.in && !where.status.in.includes(row.status)) match = false;
                if (where.customerId !== undefined && row.customerId !== where.customerId) match = false;
                if (match) {
                  Object.assign(row, data);
                  count++;
                }
              }
              return { count };
            },
            delete: async ({ where: { id } }) => {
              bookingRows.delete(id);
              return { id };
            },
            deleteMany: async ({ where }) => {
              let count = 0;
              for (const [id, row] of bookingRows) {
                let match = true;
                if (where.id !== undefined && row.id !== where.id) match = false;
                if (where.status !== undefined && row.status !== where.status) match = false;
                if (match) { bookingRows.delete(id); count++; }
              }
              return { count };
            },
          };
          this.cancellationPolicySetting = {
            findUnique: async () => null,
            upsert: async ({ create }) => ({ ...create, updatedAt: new Date() }),
          };
          this.memberAttendance = { findFirst: async () => null, findMany: async () => [] };
          this.memberAttendance.findFirst = async () => null;
          this.trainerAttendance = { upsert: async ({ create }) => ({ ...create }), findMany: async () => [] };
          this.trainingSession = { upsert: async ({ create }) => ({ ...create }), findMany: async () => [] };
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
          if (url.includes('auth-service') || url.includes('/internal/users')) {
            if (profileLookupThrows) throw new Error('profile lookup failed');
            if (profileIncomplete) return { data: { name: '', dateOfBirth: null } };
            return { data: { name: 'Test User', dateOfBirth: '1995-01-01' } };
          }
          if (url.includes('wallet-service')) {
            return { data: { data: null } };
          }
          if (gymLookupThrows) throw new Error('gym not found');
          if (gymOverride) return { data: { data: gymOverride } };
          if (url.includes(`/internal/${GYM.id}`)) return { data: { data: GYM } };
          throw new Error(`unexpected axios.get: ${url}`);
        },
        post: async (url, body, _opts) => {
          if (url.includes('/debit')) {
            if (walletDebitFails) throw { response: { data: { error: 'Insufficient wallet balance' } } };
            walletDebitCalls.push(body);
            return { data: { success: true } };
          }
          if (url.includes('/credit')) {
            walletCreditCalls.push(body);
            return { data: { success: true } };
          }
          return { data: {} };
        },
      },
    },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  t.mock.module(new URL('../utils/notifyPartner.js', import.meta.url).href, {
    exports: { notifyPartner: async (...args) => { notifyPartnerCalls.push(args); } },
  });

  t.mock.module(new URL('../utils/notifyCustomer.js', import.meta.url).href, {
    exports: { notifyCustomer: async (...args) => { notifyCustomerCalls.push(args); } },
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
      shiftedSlotForNow: () => ({ newStartTime: '10:00', newEndTime: '11:00' }),
      getDayOfWeek: (date) => {
        const [y, m, d] = date.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      },
    },
  });

  t.mock.module(new URL('../utils/qrToken.js', import.meta.url).href, {
    exports: {
      signQrToken: (bookingId, gymId) => `qr.${bookingId}.${gymId}.signed`,
      verifyQrToken: () => ({ valid: true }),
    },
  });

  ({ createBooking, cancelBooking, completeBooking, confirmBooking, getSlotCounts } =
    await import('../services/bookingService.js'));
  assert.equal(typeof createBooking, 'function');
});

// --- createBooking -----------------------------------------------------

test('createBooking: success creates a pending booking with debit and QR token', async () => {
  resetFakes();
  const b = await createBooking(CUSTOMER, {
    gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
  });
  assert.equal(b.status, 'pending');
  assert.equal(b.gymId, GYM.id);
  assert.equal(b.customerId, CUSTOMER);
  assert.ok(b.id);
  assert.equal(b.qrToken, `qr.${b.id}.${GYM.id}.signed`);
  assert.equal(walletDebitCalls.length, 1);
  assert.equal(walletDebitCalls[0].amount, 500);
  assert.equal(walletCreditCalls.length, 0);
});

test('createBooking: duplicate active slot throws 409', async () => {
  resetFakes();
  const existing = makeBooking({
    customerId: CUSTOMER, gymId: GYM.id,
    date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    status: 'confirmed',
  });
  bookingRows.set(existing.id, existing);

  await assert.rejects(
    () => createBooking(CUSTOMER, {
      gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    }),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.error, /already have a booking/);
      return true;
    }
  );
});

test('createBooking: cancelled slot does not block a new booking', async () => {
  resetFakes();
  const old = makeBooking({
    customerId: CUSTOMER, gymId: GYM.id,
    date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    status: 'cancelled',
  });
  bookingRows.set(old.id, old);

  const b = await createBooking(CUSTOMER, {
    gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
  });
  assert.equal(b.status, 'pending');
  assert.notEqual(b.id, old.id);
});

test('createBooking: insufficient wallet balance throws 400', async () => {
  resetFakes();
  walletDebitFails = true;

  await assert.rejects(
    () => createBooking(CUSTOMER, {
      gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /Insufficient|wallet/i);
      return true;
    }
  );
  // The pending reservation should be cleaned up after debit failure.
  const remaining = [...bookingRows.values()].filter(b => b.status === 'pending');
  assert.equal(remaining.length, 0);
});

test('createBooking: self-booking (partner booking own gym) throws 403', async () => {
  resetFakes();
  await assert.rejects(
    () => createBooking(PARTNER, {
      gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    }),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.error, /own gym/i);
      return true;
    }
  );
});

test('createBooking: unapproved gym throws 404', async () => {
  resetFakes();
  gymOverride = { ...GYM, isApproved: false };
  await assert.rejects(
    () => createBooking(CUSTOMER, {
      gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    }),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('createBooking: incomplete profile throws 400', async () => {
  resetFakes();
  profileIncomplete = true;
  await assert.rejects(
    () => createBooking(CUSTOMER, {
      gymId: GYM.id, date: TODAY_IST, startTime: '10:00', endTime: '11:00',
    }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /name|date of birth|profile/i);
      return true;
    }
  );
});

// --- cancelBooking -----------------------------------------------------

test('cancelBooking: confirmed booking cancels with full refund', async () => {
  resetFakes();
  const b = makeBooking({ status: 'confirmed', amount: 500, subscriptionId: null });
  bookingRows.set(b.id, b);

  const result = await cancelBooking(b.id, CUSTOMER);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.refundAmount, 500);
  assert.equal(result.refundRate, 1.0);
  assert.equal(walletCreditCalls.length, 1);
  assert.equal(walletCreditCalls[0].amount, 500);
});

test('cancelBooking: already cancelled booking throws 400', async () => {
  resetFakes();
  const b = makeBooking({ status: 'cancelled' });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => cancelBooking(b.id, CUSTOMER),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('cancelBooking: completed booking cannot be cancelled', async () => {
  resetFakes();
  const b = makeBooking({ status: 'completed' });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => cancelBooking(b.id, CUSTOMER),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('cancelBooking: wrong customer throws 403', async () => {
  resetFakes();
  const b = makeBooking({ status: 'confirmed', customerId: CUSTOMER });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => cancelBooking(b.id, 999),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    }
  );
});

test('cancelBooking: subscription booking skips wallet refund', async () => {
  resetFakes();
  const b = makeBooking({
    status: 'confirmed', subscriptionId: 42,
    amount: 0, partnerShare: null, commissionPct: null,
  });
  bookingRows.set(b.id, b);

  const result = await cancelBooking(b.id, CUSTOMER);
  assert.equal(result.status, 'cancelled');
  assert.equal(walletCreditCalls.length, 0, 'no wallet refund for subscription booking');
});

test('cancelBooking: records cancellationReason and nextVisitIntent', async () => {
  resetFakes();
  const b = makeBooking({ status: 'confirmed' });
  bookingRows.set(b.id, b);

  const result = await cancelBooking(b.id, CUSTOMER, {
    cancellationReason: 'work',
    nextVisitIntent: 'this_week',
  });
  assert.equal(result.cancellationReason, 'work');
  assert.equal(result.nextVisitIntent, 'this_week');
});

test('cancelBooking: non-existent booking throws 404', async () => {
  resetFakes();
  await assert.rejects(
    () => cancelBooking(99999, CUSTOMER),
    (err) => { assert.equal(err.status, 404); return true; }
  );
});

// --- completeBooking ---------------------------------------------------

test('completeBooking: partner completes own gym booking with attendedAt', async () => {
  resetFakes();
  const todayStr = TODAY_IST;
  const b = makeBooking({
    status: 'started', attendedAt: new Date(),
    gymId: GYM.id, date: todayStr,
  });
  bookingRows.set(b.id, b);

  const result = await completeBooking(b.id, GYM.id, PARTNER);
  assert.equal(result.status, 'completed');
  assert.equal(walletCreditCalls.length, 1);
  assert.equal(walletCreditCalls[0].amount, b.partnerShare);
});

test('completeBooking: wrong partner throws 403', async () => {
  resetFakes();
  const b = makeBooking({
    status: 'started', attendedAt: new Date(),
    gymId: GYM.id, date: TODAY_IST,
  });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => completeBooking(b.id, GYM.id, OTHER_PARTNER),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    }
  );
});

test('completeBooking: non-started booking (pending) throws 400', async () => {
  resetFakes();
  const b = makeBooking({ status: 'pending', date: TODAY_IST });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => completeBooking(b.id, GYM.id, PARTNER),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /cannot be completed/i);
      return true;
    }
  );
});

test('completeBooking: cancelled booking throws 400', async () => {
  resetFakes();
  const b = makeBooking({ status: 'cancelled', date: TODAY_IST });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => completeBooking(b.id, GYM.id, PARTNER),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('completeBooking: confirmed booking without attendedAt and no override throws 400', async () => {
  resetFakes();
  const b = makeBooking({
    status: 'confirmed', attendedAt: null,
    date: TODAY_IST,
  });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => completeBooking(b.id, GYM.id, PARTNER, { override: false }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /Attendance must be verified/i);
      return true;
    }
  );
});

test('completeBooking: confirmed booking with override succeeds', async () => {
  resetFakes();
  const b = makeBooking({
    status: 'confirmed', attendedAt: null,
    date: TODAY_IST,
  });
  bookingRows.set(b.id, b);

  const result = await completeBooking(b.id, GYM.id, PARTNER, {
    override: true,
    overrideReason: 'Customer phone died',
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.attendedAt);
  assert.equal(result.attendanceMethod, 'manual_override');
  assert.equal(result.attendanceOverrideReason, 'Customer phone died');
});

test('completeBooking: non-existent booking throws 404', async () => {
  resetFakes();
  await assert.rejects(
    () => completeBooking(99999, GYM.id, PARTNER),
    (err) => { assert.equal(err.status, 404); return true; }
  );
});

// --- confirmBooking ----------------------------------------------------

test('confirmBooking: partner confirms pending booking', async () => {
  resetFakes();
  const b = makeBooking({ status: 'pending' });
  bookingRows.set(b.id, b);

  const result = await confirmBooking(b.id, GYM.id, PARTNER);
  assert.equal(result.status, 'confirmed');
});

test('confirmBooking: already confirmed booking throws 400', async () => {
  resetFakes();
  const b = makeBooking({ status: 'confirmed' });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => confirmBooking(b.id, GYM.id, PARTNER),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /already confirmed/i);
      return true;
    }
  );
});

test('confirmBooking: wrong partner throws 403', async () => {
  resetFakes();
  const b = makeBooking({ status: 'pending' });
  bookingRows.set(b.id, b);

  await assert.rejects(
    () => confirmBooking(b.id, GYM.id, OTHER_PARTNER),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    }
  );
});

test('confirmBooking: wrong partner for gym throws 403', async () => {
  resetFakes();
  const b = makeBooking({ status: 'pending', gymId: GYM.id });
  bookingRows.set(b.id, b);
  // GYM has partnerId=20, but OTHER_PARTNER=99 does not own it
  await assert.rejects(
    () => confirmBooking(b.id, GYM.id, OTHER_PARTNER),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    }
  );
});

test('confirmBooking: non-existent booking throws 404', async () => {
  resetFakes();
  await assert.rejects(
    () => confirmBooking(99999, GYM.id, PARTNER),
    (err) => { assert.equal(err.status, 404); return true; }
  );
});

// --- getSlotCounts -----------------------------------------------------

test('getSlotCounts: returns correct booked counts per slot', async () => {
  resetFakes();
  bookingRows.set(1, makeBooking({ id: 1, startTime: '07:00', gymId: GYM.id, date: TODAY_IST, status: 'confirmed', classId: null }));
  bookingRows.set(2, makeBooking({ id: 2, startTime: '07:00', gymId: GYM.id, date: TODAY_IST, status: 'confirmed', classId: null }));
  bookingRows.set(3, makeBooking({ id: 3, startTime: '08:00', gymId: GYM.id, date: TODAY_IST, status: 'started', classId: null }));

  const counts = await getSlotCounts(GYM.id, TODAY_IST);
  assert.equal(counts['07:00'], 2);
  assert.equal(counts['08:00'], 1);
});

test('getSlotCounts: cancelled bookings are excluded', async () => {
  resetFakes();
  bookingRows.set(1, makeBooking({ id: 1, startTime: '07:00', gymId: GYM.id, date: TODAY_IST, status: 'confirmed', classId: null }));
  bookingRows.set(2, makeBooking({ id: 2, startTime: '07:00', gymId: GYM.id, date: TODAY_IST, status: 'cancelled', classId: null }));

  const counts = await getSlotCounts(GYM.id, TODAY_IST);
  assert.equal(counts['07:00'], 1);
});

test('getSlotCounts: empty date returns empty object', async () => {
  resetFakes();
  const counts = await getSlotCounts(GYM.id, '2099-12-31');
  assert.deepEqual(counts, {});
});

test('getSlotCounts: class bookings excluded from plain slot counts', async () => {
  resetFakes();
  bookingRows.set(1, makeBooking({ id: 1, startTime: '07:00', gymId: GYM.id, date: TODAY_IST, status: 'confirmed', classId: null }));
  bookingRows.set(2, makeBooking({ id: 2, startTime: '07:00', gymId: GYM.id, date: TODAY_IST, status: 'confirmed', classId: 5 }));

  const counts = await getSlotCounts(GYM.id, TODAY_IST);
  assert.equal(counts['07:00'], 1, 'class booking must not count toward plain slot capacity');
});

test('getSlotCounts: other gym bookings are excluded', async () => {
  resetFakes();
  bookingRows.set(1, makeBooking({ id: 1, startTime: '07:00', gymId: GYM.id, date: TODAY_IST, status: 'confirmed', classId: null }));
  bookingRows.set(2, makeBooking({ id: 2, startTime: '07:00', gymId: 99, date: TODAY_IST, status: 'confirmed', classId: null }));

  const counts = await getSlotCounts(GYM.id, TODAY_IST);
  assert.equal(counts['07:00'], 1);
});
