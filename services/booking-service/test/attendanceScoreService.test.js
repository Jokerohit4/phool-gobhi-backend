// Pure unit tests for the leaderboard score engine (attendanceScoreService).
// No prisma/axios to mock — the module is dependency-free by design. Covers
// the trust ladder, per-day best-trust de-dupe, time decay, window bounds,
// steps weightage, the recent-week bonus, and the 0-100 cap.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  windowDaysFor,
  scoreWindow,
  computeScores,
  SCORE_TRUST,
} from '../services/attendanceScoreService.js';

const IST_OFFSET_MS = (5 * 60 + 30) * 60000;
// An event whose IST calendar day is exactly dayKey.
const atDay = (dayKey) => new Date(Date.parse(dayKey + 'T00:00:00Z') + IST_OFFSET_MS);
const TODAY = new Date('2026-09-23T12:00:00Z'); // IST 2026-09-23
const day = (offset) => {
  const d = new Date(TODAY.getTime() + offset * 86400000);
  return new Date(Date.parse(d.toISOString().slice(0, 10) + 'T00:00:00Z') + IST_OFFSET_MS);
};

test('windowDaysFor: known windows map, anything else falls back to all-time', () => {
  assert.equal(windowDaysFor('weekly'), 7);
  assert.equal(windowDaysFor('monthly'), 30);
  assert.equal(windowDaysFor('all'), 90);
  assert.equal(windowDaysFor('nonsense'), 90);
});

test('scoreWindow: startUtc is the IST midnight bound of the window start', () => {
  const { winDays, startKey, startUtc } = scoreWindow(TODAY, 'weekly');
  assert.equal(winDays, 7);
  assert.equal(startKey, '2026-09-17');
  // IST 2026-09-17 00:00 = UTC 2026-09-16 18:30.
  assert.equal(startUtc.toISOString(), '2026-09-16T18:30:00.000Z');
});

test('trust ladder: better-proven check-ins score more for the same attendance', () => {
  const userId = 1;
  const score = (source) =>
    computeScores({
      gymId: 9,
      attendanceEvents: [{ userId, gymId: 9, attendedAt: day(0), source }],
      dailyActivityRows: [],
      userIds: [userId],
      window: 'weekly',
      today: TODAY,
    })[userId];

  assert.ok(score('member_checkin') > score('booking'));
  assert.ok(score('booking') > score('self_checkin'));
  assert.ok(score('self_checkin') > score('manual'));
  assert.equal(score('self_checkin') + 0, score('self_checkin'));
});

test('trust ladder: an unknown source contributes nothing, not a default', () => {
  const userId = 1;
  const s = computeScores({
    gymId: 9,
    attendanceEvents: [{ userId, gymId: 9, attendedAt: day(0), source: 'time_machine' }],
    dailyActivityRows: [],
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  })[userId];
  assert.equal(s, 0);
});

test('per-day best trust: two methods the same day pay the higher trust once', () => {
  const userId = 1;
  const both = computeScores({
    gymId: 9,
    attendanceEvents: [
      { userId, gymId: 9, attendedAt: day(0), source: 'member_checkin' },
      { userId, gymId: 9, attendedAt: day(0), source: 'booking' },
    ],
    dailyActivityRows: [],
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  })[userId];
  const single = computeScores({
    gymId: 9,
    attendanceEvents: [{ userId, gymId: 9, attendedAt: day(0), source: 'member_checkin' }],
    dailyActivityRows: [],
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  })[userId];
  assert.equal(both, single, 'a second, lower-trust event the same day must not double-pay');
});

test('decay: an old visit contributes less than today\'s, and old-enough days drop out', () => {
  const userId = 1;
  const todayScore = computeScores({
    gymId: 9,
    attendanceEvents: [{ userId, gymId: 9, attendedAt: day(0), source: 'booking' }],
    dailyActivityRows: [],
    userIds: [userId],
    window: 'monthly',
    today: TODAY,
  })[userId];
  const oldScore = computeScores({
    gymId: 9,
    attendanceEvents: [{ userId, gymId: 9, attendedAt: day(-25), source: 'booking' }],
    dailyActivityRows: [],
    userIds: [userId],
    window: 'monthly',
    today: TODAY,
  })[userId];
  assert.ok(todayScore > oldScore, 'a fresh visit must outweigh an old one');

  const outOfWindow = computeScores({
    gymId: 9,
    attendanceEvents: [{ userId, gymId: 9, attendedAt: day(-31), source: 'member_checkin' }],
    dailyActivityRows: [],
    userIds: [userId],
    window: 'monthly',
    today: TODAY,
  })[userId];
  assert.equal(outOfWindow, 0, 'an event before the window must not count');
});

test('gym scoping: another gym\'s events never credit this gym\'s board', () => {
  const userId = 1;
  const s = computeScores({
    gymId: 9,
    attendanceEvents: [{ userId, gymId: 10, attendedAt: day(0), source: 'member_checkin' }],
    dailyActivityRows: [],
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  })[userId];
  assert.equal(s, 0);
});

test('steps: a 10k/day week maxes the steps bucket; partial coverage scales', () => {
  const userId = 1;
  const weekFull = computeScores({
    gymId: 9,
    attendanceEvents: [],
    dailyActivityRows: Array.from({ length: 7 }, (_, i) => ({
      userId,
      date: day(-i).toISOString().slice(0, 10),
      steps: 10000,
    })),
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  })[userId];
  assert.equal(weekFull, 20, 'full 10k/day week = full 20-point steps bucket');

  const oneDay = computeScores({
    gymId: 9,
    attendanceEvents: [],
    dailyActivityRows: [{ userId, date: day(0).toISOString().slice(0, 10), steps: 10000 }],
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  })[userId];
  assert.equal(oneDay, 3, 'one 10k day = 20/7 ~ 2.86 -> rounds to 3');
});

test('recent bonus: 7/7 attended days in the last week hits the 10-point cap', () => {
  const userId = 1;
  const events = Array.from({ length: 7 }, (_, i) => ({
    userId,
    gymId: 9,
    attendedAt: day(-i),
    source: 'member_checkin',
  }));
  const score = computeScores({
    gymId: 9,
    attendanceEvents: events,
    dailyActivityRows: [],
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  });
  // 7 distinct recent days cap the recent bonus at 10; a full week of the
  // highest-trust check-ins tops the attendance bucket at 70.
  assert.equal(score[userId], 80, '70 attendance + 10 recent, no steps');
});

test('composition: attendance + steps + recent cap at 100', () => {
  const userId = 1;
  const events = Array.from({ length: 7 }, (_, i) => ({
    userId,
    gymId: 9,
    attendedAt: day(-i),
    source: 'member_checkin',
  }));
  const activity = Array.from({ length: 7 }, (_, i) => ({
    userId,
    date: day(-i).toISOString().slice(0, 10),
    steps: 10000,
  }));
  const score = computeScores({
    gymId: 9,
    attendanceEvents: events,
    dailyActivityRows: activity,
    userIds: [userId],
    window: 'weekly',
    today: TODAY,
  });
  assert.equal(score[userId], 100);
});

test('a user with no events and no activity scores 0 but is still present', () => {
  const userId = 99;
  const scores = computeScores({
    gymId: 9,
    attendanceEvents: [],
    dailyActivityRows: [],
    userIds: [1, userId],
    window: 'all',
    today: TODAY,
  });
  assert.equal(scores[userId], 0);
  assert.ok(99 in scores);
});

test('every known source has an explicit trust value in (0, 1]', () => {
  for (const source of ['member_checkin', 'booking', 'self_checkin', 'manual']) {
    const trust = SCORE_TRUST[source];
    assert.ok(trust > 0 && trust <= 1, `${source} trust ${trust}`);
  }
});