// Covers getMemberActivityForGym's POPULATION (attendance-SaaS wedge only:
// subscription-covered bookings that were verified attended + QR/link member
// check-ins; marketplace bookings excluded) and its ARRIVAL-TIME basis for
// the "same time vs varies" classification. Run with:
//   node --experimental-test-module-mocks --test test/memberActivityPopulation.test.js
//
// bookingService.js, @prisma/client, axios and googleIdToken are mocked once,
// same convention as the other tests in this directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GYM = 5;
const PARTNER = 99;
const OTHER_PARTNER = 88;
const TODAY = new Date().toISOString().split('T')[0];

// Prisma rows fed to the mocked findMany calls — select fields mirror the
// real select clauses in computeMemberActivity.
let bookingRows = [];
let memberRows = [];
let users = {};

function resetFakes() {
  bookingRows = [];
  memberRows = [];
  users = {};
}

// IST = UTC + 5:30, so "arrives at 06:55 IST" is 01:25Z the same day.
function utcForIST(h, m) {
  return new Date(`${TODAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`).toISOString();
}

let getMemberActivityForGym;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = {
            findMany: async ({ where }) => {
              const d = where.date;
              return bookingRows.filter((r) =>
                r.gymId === where.gymId
                && (!d?.gte || r.date >= d.gte)
                && (!d?.lte || r.date <= d.lte)
                && (where.isAttendanceSaas === undefined || r.isAttendanceSaas === where.isAttendanceSaas)
                && (where.attendedAt === undefined || r.attendedAt !== null));
            },
          };
          this.memberAttendance = {
            findMany: async ({ where }) => {
              const d = where.date;
              return memberRows.filter((r) =>
                r.gymId === where.gymId
                && (!d?.gte || r.date >= d.gte)
                && (!d?.lte || r.date <= d.lte));
            },
          };
        }
      },
      Prisma: {},
    },
  });

  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url) => {
          if (url.includes(`/internal/${GYM}`)) {
            return { data: { data: { id: GYM, partnerId: PARTNER } } };
          }
          if (url.includes(`/internal/${OTHER_PARTNER}`)) {
            return { data: { data: { id: GYM, partnerId: OTHER_PARTNER } } };
          }
          throw new Error(`unexpected GET ${url}`);
        },
        post: async (url, body) => {
          if (url.includes('/internal/users/batch')) {
            const data = (body.ids ?? []).map((id) => users[id]).filter(Boolean);
            return { data: { data } };
          }
          throw new Error(`unexpected POST ${url}`);
        },
      },
    },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  ({ getMemberActivityForGym } = await import('../services/bookingService.js'));
  assert.equal(typeof getMemberActivityForGym, 'function');
});

test('a non-partner may not read another gym\'s member activity', async () => {
  resetFakes();
  await assert.rejects(
    getMemberActivityForGym(GYM, OTHER_PARTNER, 7),
    (err) => err.status === 403,
  );
});

test('marketplace bookings are excluded; saas bookings + QR check-ins are merged', async () => {
  resetFakes();
  users = {
    1: { id: 1, name: 'SaaS Booker' },
    2: { id: 2, name: 'QR Member' },
    3: { id: 3, name: 'Marketplace-only' },
  };
  bookingRows = [
    { customerId: 1, gymId: GYM, date: TODAY, startTime: '06:00', endTime: '07:00', isAttendanceSaas: true, attendedAt: new Date(utcForIST(6, 55)) },
    // Marketplace booking — same gym, verified attended, but NOT part of the
    // attendance-SaaS wedge: must not show up next to the roster.
    { customerId: 3, gymId: GYM, date: TODAY, startTime: '12:00', endTime: '13:00', isAttendanceSaas: false, attendedAt: new Date(utcForIST(12, 0)) },
  ];
  memberRows = [
    { customerId: 2, gymId: GYM, date: TODAY, checkedInAt: new Date(utcForIST(8, 5)) },
  ];

  const result = await getMemberActivityForGym(GYM, PARTNER, 7);

  const ids = result.members.map((m) => m.customerId).sort();
  assert.deepEqual(ids, [1, 2], 'customer 3 (marketplace-only) must be excluded');
  const b = result.members.find((m) => m.customerId === 1);
  const q = result.members.find((m) => m.customerId === 2);
  assert.equal(b.visitCount, 1);
  assert.equal(b.totalMinutes, 60, 'slot duration counted for a verified saas booking');
  assert.equal(q.visitCount, 1);
  assert.equal(q.totalMinutes, 0, 'bare QR check-in has no slot, so zero minutes');
  assert.equal(q.mostCommonHour, 8, 'QR arrival at 08:05 IST -> 8');
});

test('the "same time" classification uses ARRIVAL time, not the booked slot start', async () => {
  resetFakes();
  users = { 4: { id: 4, name: 'Lazy Slot Booker' } };
  // Booked slots are hours apart, but the member actually ARRIVED within
  // minutes both days — must classify as the same time anyway.
  bookingRows = [
    { customerId: 4, gymId: GYM, date: TODAY, startTime: '06:00', endTime: '09:00', isAttendanceSaas: true, attendedAt: new Date(utcForIST(6, 55)) },
    { customerId: 4, gymId: GYM, date: TODAY, startTime: '18:00', endTime: '21:00', isAttendanceSaas: true, attendedAt: new Date(utcForIST(7, 5)) },
  ];

  const result = await getMemberActivityForGym(GYM, PARTNER, 7);
  const m = result.members.find((r) => r.customerId === 4);

  assert.equal(m.visitCount, 2);
  assert.equal(m.totalMinutes, 360, 'both booked slot durations summed');
  assert.equal(m.consistencyRatio, 1.0, 'arrivals 6:55 + 7:05 cluster together (old hour-bucket logic scored this 0.5)');
  assert.equal(m.mostCommonHour, 7, 'cluster mean ~7:00 IST rounds to 7 AM');
});

test('a booking + a QR check-in from the same customer combine into one row', async () => {
  resetFakes();
  users = { 5: { id: 5, name: 'Hybrid' } };
  bookingRows = [
    { customerId: 5, gymId: GYM, date: TODAY, startTime: '07:00', endTime: '08:00', isAttendanceSaas: true, attendedAt: new Date(utcForIST(7, 0)) },
  ];
  memberRows = [
    { customerId: 5, gymId: GYM, date: TODAY, checkedInAt: new Date(utcForIST(7, 10)) },
    { customerId: 5, gymId: GYM, date: TODAY, checkedInAt: new Date(utcForIST(7, 30)) },
  ];

  const result = await getMemberActivityForGym(GYM, PARTNER, 7);
  const m = result.members.find((r) => r.customerId === 5);

  assert.equal(m.visitCount, 3, '1 booking + 2 QR check-ins');
  assert.equal(m.totalMinutes, 60, 'only the booking contributes minutes');
  assert.equal(m.consistencyRatio, 1.0, 'all arrivals within 7:00-7:30 cluster together');
  assert.equal(m.mostCommonHour, 7);
});

test('activity outside the requested window is excluded', async () => {
  resetFakes();
  users = { 6: { id: 6, name: 'Old Timer' } };
  bookingRows = [
    { customerId: 6, gymId: GYM, date: TODAY, startTime: '07:00', endTime: '08:00', isAttendanceSaas: true, attendedAt: new Date(utcForIST(7, 0)) },
    { customerId: 6, gymId: GYM, date: '2020-01-01', startTime: '07:00', endTime: '08:00', isAttendanceSaas: true, attendedAt: new Date('2020-01-01T01:30:00.000Z') },
  ];

  const result = await getMemberActivityForGym(GYM, PARTNER, 7);
  const m = result.members.find((r) => r.customerId === 6);

  assert.equal(m.visitCount, 1, 'the 2020 booking is outside the 7-day window');
});

test('day windows outside [1..90] fall back to the default 7; 90 is accepted', async () => {
  resetFakes();
  users = { 7: { id: 7, name: 'Whatever' } };
  bookingRows = [
    { customerId: 7, gymId: GYM, date: TODAY, startTime: '07:00', endTime: '08:00', isAttendanceSaas: true, attendedAt: new Date(utcForIST(7, 0)) },
  ];

  const invalid = await getMemberActivityForGym(GYM, PARTNER, 10000);
  assert.equal(invalid.windowDays, 7);
  const valid = await getMemberActivityForGym(GYM, PARTNER, 90);
  assert.equal(valid.windowDays, 90);
});