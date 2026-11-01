// getShowedUpDays cache (forced ON for this file; the runner disables it by default).
// It fronts a cross-service HTTP call to booking-service that every journey/plan
// read used to pay. Pinned: cached within the TTL, parallel callers share one
// load, ranged/limited calls bypass it, a degraded result (booking-service
// down) is never cached, and the bus evicts.
// Run with: node --experimental-test-module-mocks --test
process.env.HEALTH_CACHE_FORCE = '1';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let bookingCalls = 0;
let bookingFails = false;
let bookingDays = [];
let getShowedUpDays;
let emitJourneyInvalidate;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function reset() {
  bookingCalls = 0; bookingFails = false; bookingDays = ['2026-10-30', '2026-10-29'];
  emitJourneyInvalidate?.(1); emitJourneyInvalidate?.(2);
}

test('setup: fake Prisma + booking I/O, import the real service', async () => {
  mock.module('@prisma/client', { exports: { PrismaClient: class {
    workoutSession = { findMany: async () => [] };
  } } });
  mock.module(new URL('../utils/fetchInternal.js', import.meta.url).href, {
    exports: { fetchInternal: async () => {
      bookingCalls++;
      await tick(10);
      if (bookingFails) throw new Error('booking unavailable');
      return { data: { days: bookingDays } };
    } },
  });
  ({ getShowedUpDays } = await import('../services/journey/showedUpDays.js'));
  ({ emitJourneyInvalidate } = await import('../utils/journeyCacheBus.js'));
});

test('second call within the TTL does not call booking-service again', async () => {
  reset();
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-30', '2026-10-29']);
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-30', '2026-10-29']);
  assert.equal(bookingCalls, 1);
});

test('parallel callers share one booking-service call', async () => {
  reset();
  await Promise.all([getShowedUpDays(1), getShowedUpDays(1), getShowedUpDays(1)]);
  assert.equal(bookingCalls, 1);
});

test('callers get their own copy of the array', async () => {
  reset();
  const a = await getShowedUpDays(1);
  a.push('1999-01-01');
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-30', '2026-10-29']);
});

test('ranged / limited calls bypass the cache (weekSummary asks for a 7-day window)', async () => {
  reset();
  await getShowedUpDays(1);
  await getShowedUpDays(1, '2026-10-26', { to: '2026-11-01', limit: 7 });
  await getShowedUpDays(1, '2026-10-26', { to: '2026-11-01', limit: 7 });
  assert.equal(bookingCalls, 3, 'one cached full-history load + two uncached ranged loads');
});

test('a degraded result (booking-service down) is served but NOT cached', async () => {
  reset();
  bookingFails = true;
  assert.deepEqual(await getShowedUpDays(1), [], 'falls back to workout days only, as before');
  bookingFails = false;
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-30', '2026-10-29'], 'recovered on the very next call');
  assert.equal(bookingCalls, 2);
});

test('the journey bus evicts the cache (workout finish / consent erase)', async () => {
  reset();
  await getShowedUpDays(1);
  bookingDays = ['2026-10-31', '2026-10-30', '2026-10-29'];
  emitJourneyInvalidate(1);
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-31', '2026-10-30', '2026-10-29']);
});

test('users are cached separately', async () => {
  reset();
  await getShowedUpDays(1);
  await getShowedUpDays(2);
  assert.equal(bookingCalls, 2);
});
