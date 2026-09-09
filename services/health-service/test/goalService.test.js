// FR-04. Two properties matter here and neither is obvious from the code:
//
//   1. A derived goal is PERSISTED the first time it's resolved. If it were
//      recomputed per request, a transient auth-service failure would hand
//      the user a different target between two renders of the same screen.
//   2. The goal week is Monday-start UTC, the same boundary
//      challenge-service's UserStreakWeek uses. A ring that resets on a
//      different day from the streak beside it is a bug report waiting to
//      happen, and the two live in different services with no shared code.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let goalRow = null;
let sessions = [];
let profile = null;
let profileCalls = 0;
let createCalls = [];

let resolveGoalService, setGoalService, getGoalStateService, startOfIsoWeek, NEUTRAL_DEFAULT;

test('setup: mock prisma + auth-service, import goalService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.weeklyGoal = {
            findUnique: async () => goalRow,
            create: async ({ data }) => {
              createCalls.push(data);
              goalRow = { ...data };
              return goalRow;
            },
            upsert: async ({ create, update }) => {
              goalRow = goalRow ? { ...goalRow, ...update } : { ...create };
              return goalRow;
            },
          };
          this.workoutSession = {
            findMany: async ({ where }) => {
              // Only the filters the assertions depend on are honoured; the
              // date window is applied by the caller's own bucketing.
              assert.equal(where.endedAt.not, null);
              assert.deepEqual(where.NOT, { type: 'rest' });
              return sessions;
            },
          };
        }
      },
    },
  });

  t.mock.module('../utils/fetchUserProfile.js', {
    exports: {
      fetchUserProfileInternal: async () => {
        profileCalls++;
        return profile;
      },
    },
  });

  ({ resolveGoalService, setGoalService, getGoalStateService, startOfIsoWeek, NEUTRAL_DEFAULT } =
    await import('../services/goalService.js'));
});

function reset() {
  goalRow = null;
  sessions = [];
  profile = null;
  profileCalls = 0;
  createCalls = [];
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

test('startOfIsoWeek lands on Monday 00:00 UTC, whatever day it is given', () => {
  // 2026-09-09 is a Wednesday; its ISO week starts Monday the 7th.
  assert.equal(isoDay(startOfIsoWeek(new Date('2026-09-09T18:30:00Z'))), '2026-09-07');
  // A Monday is its own week start...
  assert.equal(isoDay(startOfIsoWeek(new Date('2026-09-07T00:00:00Z'))), '2026-09-07');
  // ...and a Sunday belongs to the week that began six days earlier, not to
  // the one starting tomorrow. This is the off-by-one that would silently
  // desync the ring from the streak.
  assert.equal(isoDay(startOfIsoWeek(new Date('2026-09-13T23:59:00Z'))), '2026-09-07');
});

test('a stated onboarding intent seeds the goal', async () => {
  reset();
  profile = { weeklyFrequencyIntent: 'five_plus' };

  const goal = await resolveGoalService(1);

  assert.equal(goal.sessionsPerWeek, 5);
  assert.equal(goal.source, 'onboarding');
});

test('each intent band maps to its low end, so the goal is clearable', async () => {
  for (const [intent, expected] of [['one_two', 2], ['three_four', 3], ['five_plus', 5]]) {
    reset();
    profile = { weeklyFrequencyIntent: intent };
    const goal = await resolveGoalService(1);
    assert.equal(goal.sessionsPerWeek, expected, intent);
  }
});

test('no intent falls back to the neutral default', async () => {
  reset();
  profile = { weeklyFrequencyIntent: null };

  const goal = await resolveGoalService(1);

  assert.equal(goal.sessionsPerWeek, NEUTRAL_DEFAULT);
  assert.equal(goal.source, 'default');
});

test('an unreachable auth-service still yields a goal', async () => {
  reset();
  profile = null; // fetchUserProfileInternal swallows the error and returns null

  const goal = await resolveGoalService(1);

  assert.equal(goal.sessionsPerWeek, NEUTRAL_DEFAULT);
});

test('a derived goal is persisted, and not re-derived on the next read', async () => {
  reset();
  profile = { weeklyFrequencyIntent: 'one_two' };

  await resolveGoalService(1);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].setByUser, false);

  // Second read: no second call to auth-service, and the number is stable
  // even though the intent has since changed underneath.
  profile = { weeklyFrequencyIntent: 'five_plus' };
  const again = await resolveGoalService(1);

  assert.equal(profileCalls, 1);
  assert.equal(again.sessionsPerWeek, 2);
});

test("a user's own choice is marked as theirs and overrides the derived one", async () => {
  reset();
  profile = { weeklyFrequencyIntent: 'five_plus' };
  await resolveGoalService(1);

  const set = await setGoalService(1, 2);

  assert.equal(set.sessionsPerWeek, 2);
  assert.equal(set.source, 'user');
  assert.equal(goalRow.setByUser, true);
  assert.equal((await resolveGoalService(1)).source, 'user');
});

test('out-of-range and non-integer targets are rejected with a 400', async () => {
  reset();
  for (const bad of [0, 15, 2.5, 'three', null]) {
    await assert.rejects(() => setGoalService(1, bad), (err) => {
      assert.equal(err.status, 400);
      return true;
    }, `expected ${bad} to be rejected`);
  }
  // The edges themselves are fine.
  assert.equal((await setGoalService(1, 1)).sessionsPerWeek, 1);
  assert.equal((await setGoalService(1, 14)).sessionsPerWeek, 14);
});

test('progress counts this ISO week only, and remaining never goes negative', async () => {
  reset();
  profile = { weeklyFrequencyIntent: 'three_four' }; // target 3
  const thisWeek = isoDay(startOfIsoWeek());
  const lastWeek = isoDay(new Date(startOfIsoWeek().getTime() - 3 * 24 * 3600 * 1000));

  sessions = [
    { localDate: thisWeek, startedAt: new Date() },
    { localDate: thisWeek, startedAt: new Date() },
    { localDate: thisWeek, startedAt: new Date() },
    { localDate: thisWeek, startedAt: new Date() },
    { localDate: lastWeek, startedAt: new Date() },
  ];

  const state = await getGoalStateService(1);

  assert.equal(state.completedThisWeek, 4);
  assert.equal(state.remaining, 0, 'over-target must not report a negative remainder');
  assert.equal(state.weekStart, thisWeek);
});

test('a session with no localDate falls back to startedAt rather than vanishing', async () => {
  reset();
  profile = { weeklyFrequencyIntent: 'one_two' };
  sessions = [{ localDate: null, startedAt: new Date() }];

  const state = await getGoalStateService(1);

  assert.equal(state.completedThisWeek, 1);
});

test('re-plan is offered only after two complete short weeks with some activity', async () => {
  const weekStart = startOfIsoWeek();
  const prev1 = isoDay(new Date(weekStart.getTime() - 3 * 24 * 3600 * 1000));
  const prev2 = isoDay(new Date(weekStart.getTime() - 10 * 24 * 3600 * 1000));

  // Two short-but-not-empty weeks: the case the copy is written for.
  reset();
  profile = { weeklyFrequencyIntent: 'five_plus' }; // target 5
  sessions = [
    { localDate: prev1, startedAt: new Date() },
    { localDate: prev2, startedAt: new Date() },
  ];
  assert.equal((await getGoalStateService(1)).suggestReplan, true);

  // A brand-new account has two empty weeks behind it. Offering to lower a
  // goal before the first session would be absurd.
  reset();
  profile = { weeklyFrequencyIntent: 'five_plus' };
  sessions = [];
  assert.equal((await getGoalStateService(1)).suggestReplan, false);

  // One good week is enough to stop asking.
  reset();
  profile = { weeklyFrequencyIntent: 'one_two' }; // target 2
  sessions = [
    { localDate: prev1, startedAt: new Date() },
    { localDate: prev1, startedAt: new Date() },
    { localDate: prev2, startedAt: new Date() },
  ];
  assert.equal((await getGoalStateService(1)).suggestReplan, false);
});
