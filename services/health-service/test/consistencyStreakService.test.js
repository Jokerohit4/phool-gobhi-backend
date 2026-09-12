// D-01. The home-track streak. Four properties matter and none is obvious
// from reading the code:
//
//   1. It pays NOTHING. The response says so explicitly (verified:false,
//      earnsCoins:false) because the whole reason this exists separately
//      from challenge-service's streak is that a coin redeems for a real
//      gym pass and a self-reported log must never mint one.
//   2. An unfinished week does not break the run. Someone on a Wednesday
//      with one session logged still has until Sunday — breaking their
//      streak mid-week would punish them for the calendar.
//   3. longestWeeks can never go down, so it's computed over all history
//      rather than the window the client is shown.
//   4. Weeks are Monday-start UTC, the same boundary goalService and
//      challenge-service's UserStreakWeek use.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let sessions = [];

let getConsistencyStreakService, QUALIFYING_SESSIONS_PER_WEEK, startOfIsoWeek;

test('setup: mock prisma, import consistencyStreakService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = {
            findMany: async ({ where }) => {
              // The filters the streak depends on: only finished sessions,
              // and a logged rest day is not training.
              assert.equal(where.endedAt.not, null);
              assert.deepEqual(where.NOT, { type: 'rest' });
              return sessions;
            },
          };
          // goalService instantiates its own client at import time (this
          // service imports startOfIsoWeek from it), so the mock has to
          // satisfy that too even though these tests never read a goal.
          this.weeklyGoal = { findUnique: async () => null, create: async ({ data }) => data };
        }
      },
    },
  });

  t.mock.module('../utils/fetchUserProfile.js', {
    exports: { fetchUserProfileInternal: async () => null },
  });

  ({ getConsistencyStreakService, QUALIFYING_SESSIONS_PER_WEEK } =
    await import('../services/consistencyStreakService.js'));
  ({ startOfIsoWeek } = await import('../services/goalService.js'));
});

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function weekStartKey(weeksAgo) {
  const d = startOfIsoWeek();
  d.setUTCDate(d.getUTCDate() - weeksAgo * 7);
  return dateKey(d);
}

// `count` sessions inside the week that started `weeksAgo` weeks ago.
function logWeek(weeksAgo, count) {
  const start = new Date(`${weekStartKey(weeksAgo)}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + i);
    sessions.push({ localDate: dateKey(day), startedAt: day });
  }
}

test('a user with no sessions gets zeroes, not an error', async () => {
  sessions = [];
  const s = await getConsistencyStreakService(1);
  assert.equal(s.currentWeeks, 0);
  assert.equal(s.longestWeeks, 0);
  assert.equal(s.sessionsLogged, 0);
  assert.equal(s.thisWeekSessions, 0);
  assert.equal(s.thisWeekQualified, false);
});

test('the response states that it is unverified and pays nothing', async () => {
  sessions = [];
  const s = await getConsistencyStreakService(1);
  assert.equal(s.verified, false);
  assert.equal(s.earnsCoins, false);
  assert.equal(s.qualifyingSessionsPerWeek, QUALIFYING_SESSIONS_PER_WEEK);
});

test('an unfinished week does NOT break the run', async () => {
  sessions = [];
  logWeek(3, 2);
  logWeek(2, 2);
  logWeek(1, 2);
  logWeek(0, 1); // this week, one short of qualifying — still has time

  const s = await getConsistencyStreakService(1);
  assert.equal(s.thisWeekQualified, false);
  assert.equal(s.thisWeekSessions, 1);
  // Three completed weeks survive; the in-progress week stays neutral
  // rather than resetting them to zero.
  assert.equal(s.currentWeeks, 3);
});

test('the current week counts once it actually qualifies', async () => {
  sessions = [];
  logWeek(1, 2);
  logWeek(0, QUALIFYING_SESSIONS_PER_WEEK);

  const s = await getConsistencyStreakService(1);
  assert.equal(s.thisWeekQualified, true);
  assert.equal(s.currentWeeks, 2);
});

test('a week below the threshold does not qualify', async () => {
  sessions = [];
  logWeek(1, QUALIFYING_SESSIONS_PER_WEEK - 1);
  logWeek(0, QUALIFYING_SESSIONS_PER_WEEK);

  const s = await getConsistencyStreakService(1);
  assert.equal(s.currentWeeks, 1); // only this week
});

test('a missed week resets the run but never the all-time record', async () => {
  sessions = [];
  // A five-week run, then a gap, then two weeks.
  for (const w of [9, 8, 7, 6, 5]) logWeek(w, 2);
  // week 4 skipped entirely
  for (const w of [1, 0]) logWeek(w, 2);

  const s = await getConsistencyStreakService(1);
  assert.equal(s.currentWeeks, 2);
  assert.equal(s.longestWeeks, 5);
});

test('longestWeeks is never lower than the live run', async () => {
  sessions = [];
  logWeek(1, 2);
  logWeek(0, 2);

  const s = await getConsistencyStreakService(1);
  assert.ok(s.longestWeeks >= s.currentWeeks);
  assert.equal(s.longestWeeks, 2);
});

test('recentWeeks is oldest-first, ends on this week, and marks qualification', async () => {
  sessions = [];
  logWeek(1, 2);
  logWeek(0, 1);

  const s = await getConsistencyStreakService(1, { weeksToShow: 4 });
  assert.equal(s.recentWeeks.length, 4);
  assert.equal(s.recentWeeks[3].weekStart, weekStartKey(0));
  assert.equal(s.recentWeeks[0].weekStart, weekStartKey(3));
  assert.equal(s.recentWeeks[2].qualified, true);  // last week
  assert.equal(s.recentWeeks[3].qualified, false); // this week, one short
  assert.equal(s.recentWeeks[3].sessions, 1);
});

test('sessions predating the localDate column fall back to startedAt', async () => {
  sessions = [];
  const start = new Date(`${weekStartKey(0)}T00:00:00Z`);
  const second = new Date(start);
  second.setUTCDate(second.getUTCDate() + 1);
  // Same week, but with no localDate — the bucketing must still find it.
  sessions.push({ localDate: null, startedAt: start });
  sessions.push({ localDate: null, startedAt: second });

  const s = await getConsistencyStreakService(1);
  assert.equal(s.thisWeekSessions, 2);
  assert.equal(s.thisWeekQualified, true);
  assert.equal(s.currentWeeks, 1);
});
