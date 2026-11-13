// Covers clusterSameTimeVisits (the "same time vs varies" classification
// behind the partner app's Members attendance-activity leaderboard). Run
// with:
//   node --experimental-test-module-mocks --test test/memberActivity.test.js
//
// bookingService.js, @prisma/client, axios and googleIdToken are mocked ONCE
// for this file — same convention as gymLeaderboard.test.js. Only the pure,
// exported helper is exercised here; computeMemberActivity's DB plumbing is
// covered by that helper's contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let clusterSameTimeVisits;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {},
      Prisma: {},
    },
  });

  t.mock.module('axios', {
    exports: { default: {} },
  });

  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  ({ clusterSameTimeVisits } = await import('../services/bookingService.js'));
  assert.equal(typeof clusterSameTimeVisits, 'function');
});

function minutes(h, m = 0) {
  return h * 60 + m;
}

test('visits minutes apart across an hour boundary are the same time (6:55 + 7:05)', () => {
  const { mostCommonHour, consistencyRatio } = clusterSameTimeVisits([minutes(6, 55), minutes(7, 5)]);
  assert.equal(consistencyRatio, 1.0, 'both visits cluster together');
  assert.equal(mostCommonHour, 7, 'cluster mean 7:00 rounds to 7 AM');
});

test('a tight morning slot is one cluster (6:45, 7:00, 7:30)', () => {
  const { mostCommonHour, consistencyRatio } = clusterSameTimeVisits([
    minutes(6, 45), minutes(7), minutes(7, 30),
  ]);
  assert.equal(consistencyRatio, 2 / 3, 'clusters {6:45,7:00} and {7:30}');
  assert.equal(mostCommonHour, 7);
});

test('same-minute habit is perfect consistency (7:00, 7:05, 7:10)', () => {
  const { mostCommonHour, consistencyRatio } = clusterSameTimeVisits([
    minutes(7), minutes(7, 5), minutes(7, 10),
  ]);
  assert.equal(consistencyRatio, 1.0);
  assert.equal(mostCommonHour, 7);
});

test('genuinely different times do not cluster (7:00 vs 13:00)', () => {
  const { consistencyRatio } = clusterSameTimeVisits([minutes(7), minutes(13)]);
  assert.equal(consistencyRatio, 0.5);
});

test('evenly spaced visits are varied, not routine (7:00, 7:40, 8:20)', () => {
  const { mostCommonHour, consistencyRatio } = clusterSameTimeVisits([
    minutes(7), minutes(7, 40), minutes(8, 20),
  ]);
  assert.equal(consistencyRatio, 1 / 3, 'three separate clusters');
  assert.equal(mostCommonHour, 7, 'all clusters have one visit; the first (7:00) wins');
});

test('a dominant cluster still wins over stragglers (7, 8, 8:30)', () => {
  const { mostCommonHour, consistencyRatio } = clusterSameTimeVisits([
    minutes(7), minutes(8), minutes(8, 30),
  ]);
  assert.equal(consistencyRatio, 2 / 3, 'clusters {7} and {8,8:30}');
  assert.equal(mostCommonHour, 8, '8/8:30 cluster mean 8:15 rounds to 8');
});

test('a single visit trivially scores 1.0 (client guards on visit count)', () => {
  const { mostCommonHour, consistencyRatio } = clusterSameTimeVisits([minutes(6, 52)]);
  assert.equal(consistencyRatio, 1.0);
  assert.equal(mostCommonHour, 7);
});

test('empty input degrades to zero, never NaN', () => {
  assert.deepEqual(clusterSameTimeVisits([]), { mostCommonHour: 0, consistencyRatio: 0 });
});