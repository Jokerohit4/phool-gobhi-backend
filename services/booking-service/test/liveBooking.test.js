// nextLiveBookingAtGym: is this person a guest of the gym, and when is their
// session? A live booking (awaiting confirmation, confirmed, or in progress) for
// today or later says yes, and the soonest one is returned. A cancelled or
// completed one, an earlier day's, or one at another gym, does not count.
// Run with: node --experimental-test-module-mocks --test test/liveBooking.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

let rows = [];
let nextLiveBookingAtGym;

// The same day-string comparison the real code relies on (IST dates as YYYY-MM-DD).
const today = new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().split('T')[0];
const shift = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().split('T')[0];

test('setup: mock prisma and the network, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findFirst: async ({ where, orderBy }) => {
              const hit = rows.filter((r) => (
                r.customerId === where.customerId
                && r.gymId === where.gymId
                && where.status.in.includes(r.status)
                && r.date >= where.date.gte
              ));
              // orderBy is [{ date: 'asc' }, { startTime: 'asc' }]
              assert.deepEqual(orderBy, [{ date: 'asc' }, { startTime: 'asc' }]);
              hit.sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
              return hit[0] ?? null;
            },
          };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) } } });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: { recordAttendanceEvent: async () => {} },
  });
  ({ nextLiveBookingAtGym } = await import('../services/bookingService.js'));
  assert.equal(typeof nextLiveBookingAtGym, 'function');
});

const booking = (over) => ({ customerId: 7, gymId: 2, status: 'confirmed', date: today, startTime: '07:00', endTime: '08:00', ...over });

test('a booking today or later makes them a guest, and says how far away it is', async () => {
  for (const days of [0, 1, 30]) {
    rows = [booking({ date: shift(days) })];
    const next = await nextLiveBookingAtGym(7, 2);
    assert.equal(next.daysFromToday, days, `in ${days} days`);
    assert.equal(next.date, shift(days));
    assert.equal(next.startTime, '07:00');
    assert.equal(next.endTime, '08:00');
  }
});

test('with several, the soonest comes back: earliest day, then earliest time', async () => {
  rows = [
    booking({ date: shift(3), startTime: '06:00' }),
    booking({ date: shift(1), startTime: '19:00' }),
    booking({ date: shift(1), startTime: '07:00' }),
  ];
  const next = await nextLiveBookingAtGym(7, 2);
  assert.deepEqual([next.date, next.startTime], [shift(1), '07:00']);
});

test('pending (awaiting confirmation) and started (in progress) also count', async () => {
  for (const status of ['pending', 'started']) {
    rows = [booking({ status })];
    assert.equal((await nextLiveBookingAtGym(7, 2)).status, status, status);
  }
});

test('cancelled and completed bookings do not: a past visit is not a booking', async () => {
  for (const status of ['cancelled', 'completed']) {
    rows = [booking({ status })];
    assert.equal(await nextLiveBookingAtGym(7, 2), null, status);
  }
});

test('a booking that is over (an earlier day) does not count', async () => {
  rows = [booking({ date: shift(-1) })];
  assert.equal(await nextLiveBookingAtGym(7, 2), null);
});

test("another gym's booking, or another customer's, does not count", async () => {
  rows = [booking({ gymId: 3 }), booking({ customerId: 8 })];
  assert.equal(await nextLiveBookingAtGym(7, 2), null);
});

test('no bookings at all means not a guest', async () => {
  rows = [];
  assert.equal(await nextLiveBookingAtGym(7, 2), null);
});
