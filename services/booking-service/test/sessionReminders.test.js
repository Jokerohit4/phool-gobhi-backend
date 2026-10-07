// sendSessionReminders - the hourly "your session starts soon" push. Same
// convention as autoComplete.test.js: in-memory Prisma + axios fakes so the
// claim-then-send path runs for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const IST = 5.5 * 3600000;
// 2026-10-08 16:15 IST
const NOW = Date.UTC(2026, 9, 8, 16, 15) - IST;

const rows = new Map();
const pushes = [];
const fakePrisma = {
  booking: {
    findMany: async ({ where }) => [...rows.values()].filter(
      (b) => b.status === where.status && b.reminderSentAt == null && where.date.in.includes(b.date),
    ),
    updateMany: async ({ where, data }) => {
      const b = rows.get(where.id);
      if (!b || b.status !== where.status || b.reminderSentAt != null) return { count: 0 };
      Object.assign(b, data);
      return { count: 1 };
    },
  },
};

let sendSessionReminders;
let isDueForReminder;
let formatSlotTime;
let gymLookupFails = false;

const booking = (id, startTime, overrides = {}) => ({
  id, customerId: 100 + id, gymId: 7, date: '2026-10-08', startTime, endTime: '23:00',
  status: 'confirmed', reminderSentAt: null, ...overrides,
});

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class { constructor() { return fakePrisma; } }, Prisma: {} },
  });
  t.mock.module('axios', {
    exports: {
      default: {
        get: async () => {
          if (gymLookupFails) throw new Error('gym-service down');
          return { data: { data: { id: 7, name: 'Iron Temple' } } };
        },
        post: async () => ({ data: {} }),
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
    exports: { notifyCustomer: async (customerId, msg) => { pushes.push({ customerId, ...msg }); } },
  });
  ({ sendSessionReminders, isDueForReminder } = await import('../services/bookingService.js'));
  ({ formatSlotTime } = await import('../utils/slotTiming.js'));
});

test('due: a confirmed session 30 minutes to 2 hours out', () => {
  assert.equal(isDueForReminder(booking(1, '17:45'), NOW), true); // 1h30 out
  assert.equal(isDueForReminder(booking(1, '18:15'), NOW), true); // exactly 2h
  assert.equal(isDueForReminder(booking(1, '16:45'), NOW), true); // exactly 30m
});

test('not due: too soon, too far, already reminded, or not confirmed', () => {
  assert.equal(isDueForReminder(booking(1, '16:30'), NOW), false);
  assert.equal(isDueForReminder(booking(1, '19:00'), NOW), false);
  assert.equal(isDueForReminder(booking(1, '17:45', { reminderSentAt: new Date() }), NOW), false);
  assert.equal(isDueForReminder(booking(1, '17:45', { status: 'cancelled' }), NOW), false);
});

test('times read the way a person says them', () => {
  assert.equal(formatSlotTime('18:00'), '6:00 PM');
  assert.equal(formatSlotTime('09:30'), '9:30 AM');
  assert.equal(formatSlotTime('00:15'), '12:15 AM');
  assert.equal(formatSlotTime('12:00'), '12:00 PM');
});

test('the sweep reminds each due booking once, with the gym and the time', async () => {
  rows.clear();
  pushes.length = 0;
  rows.set(1, booking(1, '17:30'));
  rows.set(2, booking(2, '20:00')); // too far
  rows.set(3, booking(3, '17:00', { status: 'cancelled' }));

  const result = await sendSessionReminders({ nowMs: NOW });
  assert.equal(result.sent, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].customerId, 101);
  assert.equal(pushes[0].body, 'Iron Temple at 5:30 PM. Your QR is ready in My sessions.');
  assert.equal(pushes[0].data.type, 'booking_reminder');
  assert.ok(rows.get(1).reminderSentAt instanceof Date);

  const again = await sendSessionReminders({ nowMs: NOW });
  assert.equal(again.sent, 0);
  assert.equal(pushes.length, 1);
});

test('a gym lookup failure still sends the reminder, without the name', async () => {
  rows.clear();
  pushes.length = 0;
  rows.set(4, booking(4, '17:30', { gymId: 8 }));
  gymLookupFails = true;
  try {
    const result = await sendSessionReminders({ nowMs: NOW });
    assert.equal(result.sent, 1);
    assert.equal(pushes[0].body, 'Your session starts at 5:30 PM. Your QR is ready in My sessions.');
  } finally {
    gymLookupFails = false;
  }
});
