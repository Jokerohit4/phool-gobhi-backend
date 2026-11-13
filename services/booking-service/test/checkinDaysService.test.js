// Coach-journey B3: checkinDaysService — the "showed-up day" union. The
// journey's showed-up day counts a customer once per IST calendar day across
// all three check-in surfaces (Booking.attendedAt, MemberAttendance.date,
// IndependentCheckIn.date). getDays is what /internal/users/:id/checkin-days
// serves (health-service) and what getCustomerAttendanceSummary counts.
// Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const IST = 5.5 * 3600000;

// In-memory rows per model. Dates for member/independent are IST day
// strings; booking.attendedAt is a UTC instant.
const bookingRows = [];      // { customerId, attendedAt }
const memberRows = [];       // { customerId, gymId, date, checkedInAt }
const independentRows = [];  // { customerId, unclaimedGymId, date, checkedInAt }

function resetFakes() {
  bookingRows.length = 0;
  memberRows.length = 0;
  independentRows.length = 0;
}

let getDays, getLatestCheckInAt;

test('setup: mock @prisma/client once, import checkinDaysService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findMany: async ({ where }) => {
              let rows = bookingRows.filter((r) => r.customerId === where.customerId);
              if (where.attendedAt?.gte) {
                rows = rows.filter((r) => r.attendedAt.getTime() >= where.attendedAt.gte.getTime());
              }
              return rows.map((r) => ({ attendedAt: r.attendedAt }));
            },
            findFirst: async ({ where, orderBy }) => {
              const rows = bookingRows
                .filter((r) => r.customerId === where.customerId)
                .sort((a, b) => a.attendedAt - b.attendedAt);
              if (!rows.length) return null;
              const pick = orderBy?.attendedAt === 'desc' ? rows[rows.length - 1] : rows[0];
              return { attendedAt: pick.attendedAt };
            },
          };
          this.memberAttendance = {
            findMany: async ({ where }) => memberRows
              .filter((r) => r.customerId === where.customerId)
              .filter((r) => (where.date?.gte ? r.date >= where.date.gte : true))
              .map((r) => ({ date: r.date })),
            findFirst: async ({ where, orderBy }) => {
              const rows = memberRows
                .filter((r) => r.customerId === where.customerId)
                .sort((a, b) => a.checkedInAt - b.checkedInAt);
              if (!rows.length) return null;
              const pick = orderBy?.checkedInAt === 'desc' ? rows[rows.length - 1] : rows[0];
              return { checkedInAt: pick.checkedInAt };
            },
          };
          this.independentCheckIn = {
            findMany: async ({ where }) => independentRows
              .filter((r) => r.customerId === where.customerId)
              .filter((r) => (where.date?.gte ? r.date >= where.date.gte : true))
              .map((r) => ({ date: r.date })),
            findFirst: async ({ where, orderBy }) => {
              const rows = independentRows
                .filter((r) => r.customerId === where.customerId)
                .sort((a, b) => a.checkedInAt - b.checkedInAt);
              if (!rows.length) return null;
              const pick = orderBy?.checkedInAt === 'desc' ? rows[rows.length - 1] : rows[0];
              return { checkedInAt: pick.checkedInAt };
            },
          };
        }
      },
      Prisma: {},
    },
  });

  ({ getDays, getLatestCheckInAt } = await import('../services/checkinDaysService.js'));
  assert.equal(typeof getDays, 'function');
  assert.equal(typeof getLatestCheckInAt, 'function');
});

test('getDays: distinct union of all three sources, ascending', async () => {
  resetFakes();
  bookingRows.push(
    // 2026-10-10T18:00Z = 2026-10-10 23:30 IST -> day 2026-10-10
    { customerId: 1, attendedAt: new Date(Date.UTC(2026, 9, 10, 18, 0)) },
    // same IST day via a second booking -> one day, not two
    { customerId: 1, attendedAt: new Date(Date.UTC(2026, 9, 10, 14, 0)) },
  );
  memberRows.push({ customerId: 1, gymId: 7, date: '2026-10-12', checkedInAt: new Date() });
  independentRows.push({ customerId: 1, unclaimedGymId: 3, date: '2026-10-11', checkedInAt: new Date() });

  const days = await getDays(1);
  assert.deepEqual(days, ['2026-10-10', '2026-10-11', '2026-10-12']);
});

test('getDays: attendedAt near IST midnight lands on the next IST day', async () => {
  resetFakes();
  // 2026-10-10T19:00Z = 2026-10-11 00:30 IST -> day 2026-10-11, not 10-10
  bookingRows.push({ customerId: 1, attendedAt: new Date(Date.UTC(2026, 9, 10, 19, 0)) });

  const days = await getDays(1);
  assert.deepEqual(days, ['2026-10-11']);
});

test('getDays: another customer\'s rows never leak in', async () => {
  resetFakes();
  bookingRows.push({ customerId: 2, attendedAt: new Date(Date.UTC(2026, 9, 10, 18, 0)) });
  memberRows.push({ customerId: 2, gymId: 7, date: '2026-10-12', checkedInAt: new Date() });

  assert.deepEqual(await getDays(1), []);
});

test('getDays: `from` bounds every source', async () => {
  resetFakes();
  bookingRows.push(
    { customerId: 1, attendedAt: new Date(Date.UTC(2026, 9, 8, 10, 0)) },   // 2026-10-08 IST
    { customerId: 1, attendedAt: new Date(Date.UTC(2026, 9, 11, 10, 0)) },  // 2026-10-11 IST
  );
  memberRows.push(
    { customerId: 1, gymId: 7, date: '2026-10-09', checkedInAt: new Date() },
    { customerId: 1, gymId: 7, date: '2026-10-13', checkedInAt: new Date() },
  );
  independentRows.push(
    { customerId: 1, unclaimedGymId: 3, date: '2026-10-09', checkedInAt: new Date() },
    { customerId: 1, unclaimedGymId: 3, date: '2026-10-12', checkedInAt: new Date() },
  );

  const days = await getDays(1, '2026-10-10');
  assert.deepEqual(days, ['2026-10-11', '2026-10-12', '2026-10-13']);
});

test('getDays: `from` day itself is included', async () => {
  resetFakes();
  bookingRows.push({ customerId: 1, attendedAt: new Date(Date.UTC(2026, 9, 10, 18, 0)) }); // 2026-10-10 IST
  memberRows.push({ customerId: 1, gymId: 7, date: '2026-10-10', checkedInAt: new Date() });

  const days = await getDays(1, '2026-10-10');
  assert.deepEqual(days, ['2026-10-10']);
});

test('getDays: a booking attended exactly at the from-day IST boundary counts', async () => {
  resetFakes();
  // The instant 2026-10-10 00:00 IST begins — the earliest attendedAt whose
  // IST day is still 2026-10-10. The SQL bound must not cut this row off.
  bookingRows.push({ customerId: 1, attendedAt: new Date(Date.parse('2026-10-10T00:00:00Z') - IST) });
  bookingRows.push({ customerId: 1, attendedAt: new Date(Date.parse('2026-10-10T00:00:00Z') - IST - 1) });

  const days = await getDays(1, '2026-10-10');
  assert.deepEqual(days, ['2026-10-10'], 'boundary-inclusive; one ms earlier belongs to 2026-10-09 and is cut');
});

test('getLatestCheckInAt: max instant across all three sources', async () => {
  resetFakes();
  const earliest = new Date(Date.UTC(2026, 9, 8, 4, 0));
  const latest = new Date(Date.UTC(2026, 9, 9, 4, 0));
  bookingRows.push({ customerId: 1, attendedAt: earliest });
  memberRows.push({ customerId: 1, gymId: 7, date: '2026-10-08', checkedInAt: latest });

  const at = await getLatestCheckInAt(1);
  assert.equal(at.getTime(), latest.getTime());
});

test('getLatestCheckInAt: null when the customer has never checked in anywhere', async () => {
  resetFakes();
  assert.equal(await getLatestCheckInAt(1), null);
});

test('getLatestCheckInAt: an independent check-in wins when it is the newest', async () => {
  resetFakes();
  bookingRows.push({ customerId: 1, attendedAt: new Date(Date.UTC(2026, 9, 8, 4, 0)) });
  independentRows.push({
    customerId: 1, unclaimedGymId: 3, date: '2026-10-09',
    checkedInAt: new Date(Date.UTC(2026, 9, 9, 6, 0)),
  });

  const at = await getLatestCheckInAt(1);
  assert.equal(at.toISOString(), new Date(Date.UTC(2026, 9, 9, 6, 0)).toISOString());
});
