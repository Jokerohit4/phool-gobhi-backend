// Covers QA test plan D4/D5 — the badge-dedup fix. hasPriorVisitAtGym must
// treat Booking.attendedAt and MemberAttendance as ONE combined "have they
// ever visited this gym" signal, not two independent ones (the bug: a
// customer with a booked visit at gym X, doing their first member-checkin
// at gym X, must NOT look like a first-ever visit). Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function mockPrisma(t, { bookingResult = null, memberAttendanceResult = null, calls } = {}) {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findFirst: async (args) => {
              calls?.bookingArgs?.push(args);
              return bookingResult;
            },
          };
          this.memberAttendance = {
            findFirst: async (args) => {
              calls?.memberArgs?.push(args);
              return memberAttendanceResult;
            },
          };
        }
      },
      Prisma: {},
    },
  });
}

async function freshBookingService() {
  return import(`../services/bookingService.js?t=${Math.random().toString(36).slice(2)}`);
}

test('no prior visit in either table -> false', async (t) => {
  mockPrisma(t, {});
  const { hasPriorVisitAtGym } = await freshBookingService();
  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9 });
  assert.equal(result, false);
});

test('a prior BOOKING visit alone -> true', async (t) => {
  mockPrisma(t, { bookingResult: { id: 55 } });
  const { hasPriorVisitAtGym } = await freshBookingService();
  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9 });
  assert.equal(result, true);
});

test('a prior MEMBER-CHECKIN visit alone -> true (this is the bug fix)', async (t) => {
  mockPrisma(t, { memberAttendanceResult: { id: 12 } });
  const { hasPriorVisitAtGym } = await freshBookingService();
  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9 });
  assert.equal(result, true, 'a prior member-checkin at this gym must count as a prior visit even for the booking-side badge check');
});

test('regression: customer with a booked visit doing their FIRST member-checkin at the same gym is correctly seen as a repeat visitor', async (t) => {
  const calls = { bookingArgs: [], memberArgs: [] };
  // Simulates: this customer has one prior attended booking at gym 9.
  // They have zero MemberAttendance rows (this is their first member-checkin).
  mockPrisma(t, { bookingResult: { id: 55 }, memberAttendanceResult: null, calls });
  const { hasPriorVisitAtGym } = await freshBookingService();

  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9, excludeAttendanceId: 200 });
  assert.equal(result, true, 'must see the prior booking even though this call is checking from the member-checkin side');
  assert.equal(calls.memberArgs[0].where.id.not, 200, 'excludes the just-created MemberAttendance row from its own table check');
});

test('excludeBookingId omits the just-created booking row from the booking-table check', async (t) => {
  const calls = { bookingArgs: [], memberArgs: [] };
  mockPrisma(t, { calls });
  const { hasPriorVisitAtGym } = await freshBookingService();
  await hasPriorVisitAtGym({ customerId: 1, gymId: 9, excludeBookingId: 42 });
  assert.equal(calls.bookingArgs[0].where.id.not, 42);
});
