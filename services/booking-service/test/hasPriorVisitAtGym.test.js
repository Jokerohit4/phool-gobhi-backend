// Covers QA test plan D4/D5 — the badge-dedup fix. hasPriorVisitAtGym must
// treat Booking.attendedAt and MemberAttendance as ONE combined "have they
// ever visited this gym" signal, not two independent ones (the bug: a
// customer with a booked visit at gym X, doing their first member-checkin
// at gym X, must NOT look like a first-ever visit). Run with:
//   node --experimental-test-module-mocks --test
//
// bookingService.js is imported ONCE for this file (not re-imported with a
// cache-busting query string per test) — see coinEconomyConfigService's
// test header comment in the challenge-service repo for why: repeated
// cache-busted re-imports confuse --experimental-test-coverage's
// aggregation across the file. @prisma/client is mocked once with mutable
// per-test return values.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let bookingResult = null;
let memberAttendanceResult = null;
const calls = { bookingArgs: [], memberArgs: [] };

function resetFakes() {
  bookingResult = null;
  memberAttendanceResult = null;
  calls.bookingArgs = [];
  calls.memberArgs = [];
}

let hasPriorVisitAtGym;

test('setup: mock @prisma/client once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findFirst: async (args) => { calls.bookingArgs.push(args); return bookingResult; },
          };
          this.memberAttendance = {
            findFirst: async (args) => { calls.memberArgs.push(args); return memberAttendanceResult; },
          };
        }
      },
      Prisma: {},
    },
  });
  ({ hasPriorVisitAtGym } = await import('../services/bookingService.js'));
  assert.equal(typeof hasPriorVisitAtGym, 'function');
});

test('no prior visit in either table -> false', async () => {
  resetFakes();
  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9 });
  assert.equal(result, false);
});

test('a prior BOOKING visit alone -> true', async () => {
  resetFakes();
  bookingResult = { id: 55 };
  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9 });
  assert.equal(result, true);
});

test('a prior MEMBER-CHECKIN visit alone -> true (this is the bug fix)', async () => {
  resetFakes();
  memberAttendanceResult = { id: 12 };
  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9 });
  assert.equal(result, true, 'a prior member-checkin at this gym must count as a prior visit even for the booking-side badge check');
});

test('regression: customer with a booked visit doing their FIRST member-checkin at the same gym is correctly seen as a repeat visitor', async () => {
  resetFakes();
  // Simulates: this customer has one prior attended booking at gym 9, and
  // zero MemberAttendance rows (this is their first member-checkin).
  bookingResult = { id: 55 };
  memberAttendanceResult = null;

  const result = await hasPriorVisitAtGym({ customerId: 1, gymId: 9, excludeAttendanceId: 200 });
  assert.equal(result, true, 'must see the prior booking even though this call is checking from the member-checkin side');
  assert.equal(calls.memberArgs[0].where.id.not, 200, 'excludes the just-created MemberAttendance row from its own table check');
});

test('excludeBookingId omits the just-created booking row from the booking-table check', async () => {
  resetFakes();
  await hasPriorVisitAtGym({ customerId: 1, gymId: 9, excludeBookingId: 42 });
  assert.equal(calls.bookingArgs[0].where.id.not, 42);
});

test('with neither exclude id passed, the where clause has no id filter at all', async () => {
  resetFakes();
  await hasPriorVisitAtGym({ customerId: 1, gymId: 9 });
  assert.equal(calls.bookingArgs[0].where.id, undefined);
  assert.equal(calls.memberArgs[0].where.id, undefined);
});
