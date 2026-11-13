// Tests for the attendance-SaaS bill computation in services/walletService.js —
// specifically the minimum-billed-amount floor in computeAttendanceSaasBillsService:
// a gym's positive bill is raised to ATTENDANCE_SAAS_MIN_BILLED_AMOUNT when it
// computes below that, while a zero-joiner gym still bills Rs 0 (the guard in
// applyAttendanceSaasBillService depends on that staying > 0 semantics intact).
//
// Run:
//   node --experimental-test-module-mocks --test test/attendanceSaasBills.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

let computeAttendanceSaasBillsService;
let mockPrisma;
let joinedCounts = {};
let gymConfigs = new Map();

test('setup: mock dependencies and import walletService', async (t) => {
  mockPrisma = {
    walletTransaction: {},
  };

  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() { return mockPrisma; }
      },
      Prisma: {},
    },
  });

  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url) => {
          const id = Number(url.split('/internal/')[1]);
          return { data: { data: gymConfigs.get(id) ?? {} } };
        },
        post: async (url, body) => {
          if (url.endsWith('/internal/attendance-saas/joined-counts')) {
            return { data: { data: { counts: joinedCounts } } };
          }
          throw new Error(`unexpected axios.post: ${url}`);
        },
      },
    },
  });

  t.mock.module('../utils/googleIdToken.js', {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  t.mock.module('../utils/analytics.js', {
    exports: { track: () => {} },
  });

  ({ computeAttendanceSaasBillsService } = await import('../services/walletService.js'));

  assert.equal(typeof computeAttendanceSaasBillsService, 'function');
});

function seed({ gymId, usersJoined, flatFeePerUser }) {
  joinedCounts = { [gymId]: usersJoined };
  gymConfigs = new Map([
    [gymId, {
      partnerId: 5,
      attendanceSaasOptedOut: false,
      subscriptionPricingMode: 'flatPerUser',
      subscriptionFlatFeePerUser: flatFeePerUser,
    }],
  ]);
  mockPrisma.walletTransaction.findMany = async () => [];
}

test('bill over the floor passes through unchanged (150 x Rs 1 = 150)', async () => {
  seed({ gymId: 42, usersJoined: 150, flatFeePerUser: 1 });
  const [bill] = await computeAttendanceSaasBillsService([42], '2026-09');
  assert.equal(bill.usersJoined, 150);
  assert.equal(bill.amountDue, 150);
});

test('positive bill under the floor is raised to the minimum (2 x Rs 1 = Rs 99)', async () => {
  seed({ gymId: 42, usersJoined: 2, flatFeePerUser: 1 });
  const [bill] = await computeAttendanceSaasBillsService([42], '2026-09');
  assert.equal(bill.usersJoined, 2);
  assert.equal(bill.amountDue, 99);
});

test('zero joiners still bill Rs 0 - no floor applied', async () => {
  seed({ gymId: 42, usersJoined: 0, flatFeePerUser: 1 });
  const [bill] = await computeAttendanceSaasBillsService([42], '2026-09');
  assert.equal(bill.usersJoined, 0);
  assert.equal(bill.amountDue, 0);
});

test('bill exactly at the floor stays as-is (99 x Rs 1 = 99)', async () => {
  seed({ gymId: 42, usersJoined: 99, flatFeePerUser: 1 });
  const [bill] = await computeAttendanceSaasBillsService([42], '2026-09');
  assert.equal(bill.usersJoined, 99);
  assert.equal(bill.amountDue, 99);
});