// In-process gym-card cache shared by getCustomerBookings, getVisitedGyms and
// getMyAttendanceWarnings: one gym-service call per distinct gym per TTL,
// single-flight on concurrent misses, failures never cached, bounded size.
// Same mock-once-per-file convention as bookingService.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.QR_SIGNING_SECRET = 'test-signing-secret';

const CUSTOMER = 1;
const gyms = {
  10: { id: 10, name: 'Iron Temple', address: 'A', city: 'Gurugram', lat: 1, lng: 2, images: [{ url: 'img10' }] },
  11: { id: 11, name: 'Muscle Hub', address: 'B', city: 'Delhi', lat: 3, lng: 4, images: [] },
};
let gymCalls = [];
let failIds = new Set();
let bookingRows = [];
let warningRows = [];
let svc;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.booking = { findMany: async ({ where }) => bookingRows.filter((r) => r.customerId === where.customerId) };
          this.attendanceWarning = { findMany: async ({ where }) => warningRows.filter((r) => r.customerId === where.customerId) };
        }
      },
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    },
  });
  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url, opts) => {
          const id = Number(new URL(url).pathname.split('/').pop());
          gymCalls.push({ id, opts });
          await new Promise((r) => setTimeout(r, 5));
          if (failIds.has(id)) throw new Error('gym-service down');
          return { data: { data: gyms[id] || { id, name: `Gym ${id}`, city: 'X', images: [] } } };
        },
        post: async () => ({ data: {} }),
      },
    },
  });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module(new URL('../utils/notifyPartner.js', import.meta.url).href, {
    exports: { notifyPartner: async () => {}, sendPartnerPush: async () => true, resolvePartnerFcmToken: async () => null },
  });
  t.mock.module(new URL('../utils/notifyCustomer.js', import.meta.url).href, { exports: { notifyCustomer: async () => {} } });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, { exports: { recordAttendanceEvent: async () => {} } });
  t.mock.module(new URL('../utils/notifyHealthService.js', import.meta.url).href, { exports: { recordAttendanceForWorkout: async () => {} } });
  svc = await import('../services/bookingService.js');
});

function booking(id, gymId) {
  return {
    id, customerId: CUSTOMER, gymId, date: '2026-09-14', startTime: '10:00', endTime: '11:00', amount: 500,
    status: 'completed', subscriptionId: null, createdAt: new Date(), updatedAt: new Date(),
  };
}
function warning(gymId) {
  return { customerId: CUSTOMER, bookingId: gymId, gymId, date: '2026-09-14', createdAt: new Date() };
}
function reset() {
  svc._resetGymCardCache();
  gymCalls = [];
  failIds = new Set();
  bookingRows = [booking(1, 10), booking(2, 11), booking(3, 10)];
  warningRows = [];
}

test('getCustomerBookings: one gym call per distinct gym, then served from cache; output identical', async () => {
  reset();
  const first = await svc.getCustomerBookings(CUSTOMER);
  assert.deepEqual(gymCalls.map((c) => c.id).sort(), [10, 11]);
  assert.equal(gymCalls[0].opts.timeout, 5000);
  const byId = Object.fromEntries(first.map((b) => [b.id, b.gym]));
  assert.deepEqual(byId[1], { id: 10, name: 'Iron Temple', address: 'A', city: 'Gurugram', imageUrl: 'img10' });
  assert.deepEqual(byId[2], { id: 11, name: 'Muscle Hub', address: 'B', city: 'Delhi', imageUrl: null });
  const second = await svc.getCustomerBookings(CUSTOMER);
  assert.equal(gymCalls.length, 2, 'no further gym-service calls inside the TTL');
  assert.deepEqual(second.map((b) => b.gym), first.map((b) => b.gym));
});

test('concurrent requests share one in-flight lookup per gym (single-flight)', async () => {
  reset();
  await Promise.all([svc.getCustomerBookings(CUSTOMER), svc.getCustomerBookings(CUSTOMER), svc.getCustomerBookings(CUSTOMER)]);
  assert.deepEqual(gymCalls.map((c) => c.id).sort(), [10, 11]);
});

test('a failed lookup leaves gym null and is not cached; the next request retries', async () => {
  reset();
  failIds.add(11);
  const first = await svc.getCustomerBookings(CUSTOMER);
  assert.equal(first.find((b) => b.id === 2).gym, null);
  assert.equal(first.find((b) => b.id === 1).gym.name, 'Iron Temple');
  failIds.clear();
  const second = await svc.getCustomerBookings(CUSTOMER);
  assert.equal(second.find((b) => b.id === 2).gym.name, 'Muscle Hub');
  assert.deepEqual(gymCalls.map((c) => c.id), [10, 11, 11], 'gym 10 cached, gym 11 retried');
});

test('getMyAttendanceWarnings reuses the same cache and keeps its output shape', async () => {
  reset();
  await svc.getCustomerBookings(CUSTOMER); // warms 10 and 11
  warningRows = [warning(10), warning(11), warning(10)];
  gymCalls = [];
  const out = await svc.getMyAttendanceWarnings(CUSTOMER);
  assert.equal(gymCalls.length, 0);
  assert.equal(out.count, 3);
  assert.deepEqual(out.warnings.map((w) => w.gymName), ['Iron Temple', 'Muscle Hub', 'Iron Temple']);
});

test('getMyAttendanceWarnings: unreachable gym gives gymName null', async () => {
  reset();
  failIds.add(10);
  warningRows = [warning(10)];
  const out = await svc.getMyAttendanceWarnings(CUSTOMER);
  assert.equal(out.warnings[0].gymName, null);
});

test('entries expire after 5 minutes', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['Date'] });
  await svc.getCustomerBookings(CUSTOMER);
  assert.equal(gymCalls.length, 2);
  t.mock.timers.tick(5 * 60 * 1000 - 1000);
  await svc.getCustomerBookings(CUSTOMER);
  assert.equal(gymCalls.length, 2, 'still fresh just inside the TTL');
  t.mock.timers.tick(2000);
  await svc.getCustomerBookings(CUSTOMER);
  assert.equal(gymCalls.length, 4, 'refetched after the TTL');
});

test('cache is bounded: oldest entries are evicted past the max size', async () => {
  reset();
  warningRows = Array.from({ length: 600 }, (_, i) => warning(1000 + i));
  await svc.getMyAttendanceWarnings(CUSTOMER);
  assert.equal(gymCalls.length, 600);
  gymCalls = [];
  warningRows = [warning(1599)]; // newest: still cached
  await svc.getMyAttendanceWarnings(CUSTOMER);
  assert.equal(gymCalls.length, 0);
  warningRows = [warning(1000)]; // oldest: evicted
  await svc.getMyAttendanceWarnings(CUSTOMER);
  assert.equal(gymCalls.length, 1);
});
