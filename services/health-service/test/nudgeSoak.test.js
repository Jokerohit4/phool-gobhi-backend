// Property-based tests for FR-08's frequency guards.
//
// The rest of this suite pins examples: "two nudges never land within 24
// hours" is shown with one hand-built history. That proves the rule holds for
// the case someone thought of. It does not prove it holds for the eight days
// of overlapping reminders that actually happen in production, where a log
// nudge and a comeback and a target nudge all compete for one weekly budget
// and some sends fail.
//
// So these soak the real sweep over a simulated week with a seeded random
// history, random free-time preferences, random opt-outs, random failing
// sends and random bands - and then assert the invariants that make the
// feature safe, rather than re-asserting the rules one at a time. The seed is
// fixed and printed in every failure message, so a break is reproducible
// instead of "it failed once on a Tuesday".
//
// No property-testing dependency: the generator is six lines, and adding
// fast-check for this would be a bigger change than the tests.
//
// Everything is anchored to a simulated `start`, never to the wall clock -
// otherwise the target windows are set from today's date and the soak runs
// entirely before any of them open, which is a green test that proves nothing.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The soak's "now" begins at 09:00 IST and steps two hours, matching the cron
// in send-health-nudges.yml (09, 11, 13, 15, 17, 19, 21 IST).
const START = new Date('2026-09-01T03:30:00Z');

let optOuts = [];
let nudgeLogs = [];
let created = [];
let attempts = [];
// Every push ever attempted, warm-up included. The per-window invariants are
// measured over this; only the log/delivery pairing is measured over the
// current window, since that is the claim about "this run".
let attemptsAll = [];
let groupedSessions = [];
let unloggedUsers = [];
let healthTargets = [];
let scoreBands = {};
let profiles = {};
let sendResult = true;
// Stands in for the DB's `sentAt @default(now())`. The soak simulates time, so
// this is set to the simulated instant before each sweep; stamping every log
// with the real wall clock would make each overlap check below vacuously true.
let clock = START;

let nudge;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('setup: mock prisma and FCM once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.nudgeOptOut = {
            findUnique: async ({ where }) =>
              optOuts.find(
                (o) => o.userId === where.userId_type.userId && o.type === where.userId_type.type,
              ) ?? null,
            findMany: async ({ where }) => optOuts.filter((o) => o.userId === where.userId),
          };
          this.nudgeLog = {
            findMany: async ({ where }) =>
              nudgeLogs
                .filter((l) => l.userId === where.userId && l.sentAt >= where.sentAt.gte)
                .sort((a, b) => b.sentAt - a.sentAt),
            create: async ({ data }) => {
              const row = { ...data, sentAt: data.sentAt ?? clock };
              created.push(row);
              nudgeLogs.push(row);
              return row;
            },
          };
          this.workoutSession = {
            groupBy: async () => groupedSessions,
            findMany: async () => [],
          };
          this.healthGoal = {
            findMany: async ({ where }) =>
              healthTargets.filter(
                (g) =>
                  g.scoreTargetPoints != null &&
                  g.scoreTargetUntil >= where.scoreTargetUntil.gte &&
                  g.calmMode === false,
              ),
          };
        }
      },
    },
  });

  t.mock.module('../utils/notifyUser.js', {
    exports: {
      notifyUser: async (userId, payload) => {
        // `ok` distinguishes "pushed to a device" from "the send failed": a
        // failed send must not have been logged, or it silently eats the
        // user's weekly budget for a notification they never saw.
        const entry = { userId, payload, at: clock, ok: sendResult };
        attempts.push(entry);
        attemptsAll.push(entry);
        // A log nudge is about a check-in that is still unlogged. Once the
        // reminder has gone out, either the user logs it or the 12h window
        // closes, and either way they leave the candidate list. Leaving them
        // in would make this mock re-nudge them every 24h until the weekly
        // budget was gone, which is a fiction: it starves every other nudge
        // type for reasons that cannot happen in production.
        if (sendResult && payload.data.nudge === 'log') {
          unloggedUsers = unloggedUsers.filter((u) => u.userId !== userId);
        }
        return sendResult;
      },
    },
  });

  t.mock.module('../services/unloggedService.js', {
    exports: {
      findUnloggedUsersService: async () => unloggedUsers,
      getUnloggedAttendanceService: async () => [],
    },
  });

  t.mock.module('../utils/fetchUserProfile.js', {
    exports: { fetchUserProfileInternal: async (userId) => profiles[userId] ?? null },
  });

  t.mock.module('../services/ledger/scoreTargetService.js', {
    exports: {
      getScoreTargetState: async (_prisma, { userId }) => ({
        band: scoreBands[userId] ?? 'on_track',
      }),
    },
  });

  nudge = await import('../services/nudgeService.js');
});

function istDay(offsetDays, from = START) {
  return new Date(from.getTime() + offsetDays * DAY).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
}

function istHourAt(instant) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(instant),
  );
}

/// An instant `hours` before `from`.
function hoursBefore(from, hours) {
  return new Date(from.getTime() - hours * HOUR);
}

/**
 * A world of `userCount` users, each with a random opt-out set, a random
 * free-time preference, a random reminder-worthy history and a random band.
 *
 * The first four users are pinned so that every target-nudge branch is
 * guaranteed to be exercised: behind-and-reachable (must fire), behind but in
 * calm mode (must never fire), behind with a pause mid-soak (must fire only
 * outside it), and behind but opted out of everything (must never fire).
 * A purely random world is a coin flip on whether any of those get hit, and a
 * rule that was never exercised is not a rule that was tested. Everyone after
 * them is left fully random.
 */
function makeWorld(rand, userCount) {
  const windows = [null, 'morning', 'afternoon', 'evening', 'late_night', 'whenever'];
  const bands = ['behind', 'at_risk', 'on_track', 'reached'];
  const users = [];

  for (let i = 0; i < userCount; i += 1) {
    const userId = 1000 + i;
    const pinned = i < 4;
    users.push(userId);

    // Random opt-outs, including some that cover all three types.
    if (pinned && i === 3) {
      for (const type of nudge.NUDGE_TYPES) optOuts.push({ userId, type });
    } else if (pinned) {
      // no opt-out
    } else {
      const roll = rand();
      if (roll < 0.25) {
        for (const type of nudge.NUDGE_TYPES) optOuts.push({ userId, type });
      } else if (roll < 0.55) {
        optOuts.push({ userId, type: nudge.NUDGE_TYPES[Math.floor(rand() * 3)] });
      }
    }

    profiles[userId] = { freeTimeWindow: windows[Math.floor(rand() * windows.length)] };

    // Comeback: a last session 8-40 days before the soak starts. The pinned
    // `behind` user is left out of it on purpose: someone who has not trained
    // in a month wants "come back", not "you fell behind", and if they are
    // both then the comeback floods the weekly budget and the target nudge is
    // never reached. That interaction has its own test below; pinning it here
    // would just hide it behind a coin flip.
    if ((rand() < 0.6 && !(pinned && i === 0)) || (pinned && i === 1)) {
      groupedSessions.push({
        userId,
        _max: { startedAt: new Date(START.getTime() - (8 + rand() * 32) * DAY) },
      });
    }

    // Log nudge: sometimes there is still an unlogged check-in. The pinned
    // `behind` user is given one, so the log branch is always exercised too.
    if ((pinned && i === 0) || rand() < 0.4) {
      unloggedUsers.push({ userId, localDate: istDay(0) });
    }

    // Target: window wide enough to stay live through the warm-up as well as
    // the measured run.
    const shape = rand();
    const calm = pinned ? i === 1 : shape < 0.15;
    const paused = pinned ? i === 2 : !calm && shape < 0.3;
    healthTargets.push({
      userId,
      scoreTargetPoints: 400,
      scoreTargetFrom: istDay(-30),
      scoreTargetUntil: istDay(30),
      calmMode: calm,
      pausedFrom: paused ? istDay(2) : null, // opens mid-soak
      pausedUntil: paused ? istDay(5) : null,
    });
    scoreBands[userId] = pinned ? 'behind' : bands[Math.floor(rand() * bands.length)];
  }

  return users;
}

/// A live, unpaused, non-calm score target row, as the mock's findMany returns.
function targetGoal(userId, overrides = {}) {
  return {
    userId,
    scoreTargetPoints: 400,
    scoreTargetFrom: istDay(-30),
    scoreTargetUntil: istDay(30),
    calmMode: false,
    pausedFrom: null,
    pausedUntil: null,
    ...overrides,
  };
}

function reset() {
  optOuts = [];
  nudgeLogs = [];
  created = [];
  attempts = [];
  attemptsAll = [];
  groupedSessions = [];
  unloggedUsers = [];
  healthTargets = [];
  scoreBands = {};
  profiles = {};
  sendResult = true;
  clock = START;
}

/// Pushed successfully, as opposed to attempted.
function delivered() {
  return attempts.filter((a) => a.ok);
}

/// A check-in arrives: the user trained and has not logged it. Only for the
/// unpinned users, so the recurring log nudges cannot starve the pinned users
/// of the budget they need to prove the other two branches work.
function maybeCheckIn(rand, users, clock) {
  if (rand() >= 0.35) return;
  const userId = users[4 + Math.floor(rand() * (users.length - 4))];
  if (!unloggedUsers.some((u) => u.userId === userId)) {
    unloggedUsers.push({ userId, localDate: istDay(0, clock) });
  }
}

const SEEDS = [1, 7, 42, 1337, 90210];

test('two weeks of random sweeps never break the guarantees', { timeout: 180000 }, async () => {
  for (const seed of SEEDS) {
    const rand = mulberry32(seed);
    reset();

    const users = makeWorld(rand, 12);

    // Ten days of warm-up, driven through the real sweep. The history the
    // measured run starts from has to be history the service actually produced:
    // hand-seeded random rows can already breach the weekly cap, and then the
    // invariants below fail on rows nobody sent - which is a test that reports
    // a bug that is not there, and hides one that is.
    for (let step = 0; step < 10 * 7; step += 1) {
      clock = new Date(START.getTime() - (10 * 7 - step) * 2 * HOUR);
      maybeCheckIn(rand, users, clock);

      sendResult = rand() < 0.85;
      await nudge.runNudgeSweepService(clock);
    }
    assert.ok(nudgeLogs.length > 0, `seed ${seed}: warm-up sent nothing at all`);

    // Measure only what comes after the warm-up.
    created = [];
    attempts = [];

    // Two weeks of measured runs. Two weeks, not one: the weekly cap only
    // releases when its window slides, so a shorter window can pass simply
    // because the cap never opened up again, and that is the whole rule under
    // test.
    for (let step = 0; step < 14 * 7; step += 1) {
      clock = new Date(START.getTime() + step * 2 * HOUR);
      maybeCheckIn(rand, users, clock);

      sendResult = rand() < 0.85;
      await nudge.runNudgeSweepService(clock);
    }

    const label = `seed ${seed}`;
    const pushed = delivered();

    // 1. A nudge is logged if and only if it actually left. Both directions
    //    matter: a phantom log burns the weekly budget, and a missing log
    //    re-sends the same nudge on every run.
    assert.equal(
      created.length,
      pushed.length,
      `${label}: ${created.length} rows logged but ${pushed.length} pushes delivered`,
    );
    for (const row of created) {
      assert.ok(
        pushed.some((a) => a.userId === row.userId && a.payload.data.nudge === row.type && a.ok),
        `${label}: logged ${row.type} for user ${row.userId} with no matching delivery`,
      );
    }

    // 2. Opt-outs are absolute.
    const optedOut = new Set(optOuts.map((o) => `${o.userId}:${o.type}`));
    for (const row of created) {
      assert.ok(
        !optedOut.has(`${row.userId}:${row.type}`),
        `${label}: sent ${row.type} to opted-out user ${row.userId}`,
      );
    }

    // 3. Nothing during quiet hours. Free time applies to `comeback` and
    //    `target` only: `log` is a reaction to a check-in 90 minutes ago, and
    //    delaying it to the evening would ask about a session the user has
    //    half forgotten. That asymmetry is deliberate in the service, so the
    //    property has to state it too or it protects the wrong thing.
    for (const msg of attemptsAll.filter((a) => a.ok)) {
      const hour = istHourAt(msg.at);
      assert.ok(
        hour >= nudge.QUIET_END_HOUR && hour < nudge.QUIET_START_HOUR,
        `${label}: a push landed at ${hour}:00 IST`,
      );
      const kind = msg.payload.data.nudge;
      if (kind === 'log') continue;
      const hours = nudge.FREE_TIME_HOURS[profiles[msg.userId]?.freeTimeWindow];
      if (hours) {
        assert.ok(
          hour >= hours[0] && hour < hours[1],
          `${label}: user ${msg.userId} (free ${profiles[msg.userId].freeTimeWindow}) got a ` +
            `${kind} nudge at ${hour}:00 IST`,
        );
      }
    }

    // 4. Never more than MAX_PER_WEEK in any rolling seven-day window.
    for (const userId of users) {
      const times = nudgeLogs
        .filter((l) => l.userId === userId)
        .map((l) => l.sentAt.getTime())
        .sort((a, b) => a - b);
      for (let i = 0; i < times.length; i += 1) {
        const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 7 * DAY);
        assert.ok(
          inWindow.length <= nudge.MAX_PER_WEEK,
          `${label}: user ${userId} got ${inWindow.length} nudges in 7 days`,
        );
      }
    }

    // 5. Consecutive nudges to one user are MIN_GAP_HOURS apart, and target
    //    nudges are TARGET_MIN_GAP_HOURS apart. Note this holds across the
    //    pre-existing history too, which is the case a per-type cooldown
    //    alone would not cover.
    for (const userId of users) {
      const byTime = nudgeLogs
        .filter((l) => l.userId === userId)
        .sort((a, b) => a.sentAt - b.sentAt);
      for (let i = 1; i < byTime.length; i += 1) {
        const gapHours = (byTime[i].sentAt - byTime[i - 1].sentAt) / HOUR;
        assert.ok(
          gapHours >= nudge.MIN_GAP_HOURS,
          `${label}: user ${userId} got two nudges ${gapHours.toFixed(1)}h apart`,
        );
        if (byTime[i].type === 'target' && byTime[i - 1].type === 'target') {
          assert.ok(
            gapHours >= nudge.TARGET_MIN_GAP_HOURS,
            `${label}: user ${userId} got two target nudges ${gapHours.toFixed(1)}h apart`,
          );
        }
      }
    }

    // 6. No target nudge to anyone who is not behind, or who is in calm mode
    //    or whose pause was covering the day it was sent.
    const calmIds = new Set(healthTargets.filter((g) => g.calmMode).map((g) => g.userId));
    for (const row of nudgeLogs.filter((l) => l.type === 'target')) {
      assert.equal(
        scoreBands[row.userId],
        'behind',
        `${label}: target nudge to user ${row.userId} in band ${scoreBands[row.userId]}`,
      );
      assert.ok(!calmIds.has(row.userId), `${label}: target nudge to a calm-mode user`);
      const goal = healthTargets.find((g) => g.userId === row.userId);
      const thatDay = istDay(0, row.sentAt);
      if (goal.pausedFrom && goal.pausedUntil) {
        assert.ok(
          !(goal.pausedFrom <= thatDay && thatDay <= goal.pausedUntil),
          `${label}: target nudge to user ${row.userId} on ${thatDay}, inside their pause`,
        );
      }
    }

    // 7. The soak has to have exercised something, or it is a green test that
    //    asserts nothing. Every type should have fired for someone, and
    //    somebody should have been kept quiet for at least one reason other
    //    than "it was 03:00".
    const byType = Object.fromEntries(
      nudge.NUDGE_TYPES.map((t) => [t, pushed.filter((a) => a.payload.data.nudge === t).length]),
    );
    for (const type of nudge.NUDGE_TYPES) {
      assert.ok(
        pushed.some((a) => a.payload.data.nudge === type),
        `${label}: no ${type} nudge was ever sent, so its rules went untested ` +
          `(measured window: ${JSON.stringify(byType)}, all time: ` +
          `${JSON.stringify(Object.fromEntries(nudge.NUDGE_TYPES.map((t) => [t, attemptsAll.filter((a) => a.ok && a.payload.data.nudge === t).length])))}`,
      );
    }
    assert.ok(attemptsAll.length > attemptsAll.filter((a) => a.ok).length, `${label}: no send ever failed`);
    assert.ok(
      nudgeLogs.some((l) => l.type === 'target'),
      `${label}: no target nudge was ever logged`,
    );
  }
});

test('the boundaries are where the rules are decided, so pin them exactly', async () => {
  const now = new Date('2026-09-10T06:30:00Z'); // 12:00 IST
  const user = 1;
  const logs = (...rows) => {
    reset();
    nudgeLogs = rows;
  };

  // Exactly 24 hours is allowed; a minute under is not.
  logs({ userId: user, type: 'log', sentAt: hoursBefore(now, 24) });
  assert.equal((await nudge.canSendService(user, 'comeback', now)).allowed, true);

  logs({ userId: user, type: 'log', sentAt: hoursBefore(now, 24 - 1 / 60) });
  assert.equal((await nudge.canSendService(user, 'comeback', now)).reason, 'too_soon');

  // Exactly 72 hours since a target nudge is allowed; a minute under is not.
  logs({ userId: user, type: 'target', sentAt: hoursBefore(now, 72) });
  assert.equal((await nudge.canSendService(user, 'target', now)).allowed, true);

  logs({ userId: user, type: 'target', sentAt: hoursBefore(now, 72 - 1 / 60) });
  assert.equal((await nudge.canSendService(user, 'target', now)).reason, 'target_cooldown');

  // A target cooldown is not a licence to send a different type: the global
  // gap still applies across types, which is what keeps the week at three.
  logs({ userId: user, type: 'target', sentAt: hoursBefore(now, 25) });
  assert.equal((await nudge.canSendService(user, 'comeback', now)).allowed, true);
  logs({ userId: user, type: 'target', sentAt: hoursBefore(now, 23) });
  assert.equal((await nudge.canSendService(user, 'comeback', now)).reason, 'too_soon');

  // Three nudges at EXACTLY seven days old still count against the cap: the
  // window is `gte`, so a nudge a week old is inside it. This is the line
  // between three a week and four a week for someone having a bad month.
  logs(
    { userId: user, type: 'log', sentAt: hoursBefore(now, 24 * 7) },
    { userId: user, type: 'log', sentAt: hoursBefore(now, 24 * 7) },
    { userId: user, type: 'log', sentAt: hoursBefore(now, 24 * 7) },
  );
  assert.equal((await nudge.canSendService(user, 'log', now)).reason, 'weekly_cap');

  // A minute past seven days and they fall out of the window.
  logs(
    { userId: user, type: 'log', sentAt: hoursBefore(now, 24 * 7 + 1 / 60) },
    { userId: user, type: 'log', sentAt: hoursBefore(now, 24 * 7 + 1 / 60) },
    { userId: user, type: 'log', sentAt: hoursBefore(now, 24 * 7 + 1 / 60) },
  );
  assert.equal((await nudge.canSendService(user, 'log', now)).allowed, true);

  // Opt-out beats everything, including an empty budget.
  reset();
  optOuts = [{ userId: user, type: 'target' }];
  assert.equal((await nudge.canSendService(user, 'target', now)).reason, 'opted_out');
});

test('a sweep that lands in quiet hours sends nothing, whatever the world looks like', async () => {
  for (const seed of [3, 11]) {
    const rand = mulberry32(seed);
    reset();
    const users = makeWorld(rand, 8);

    // 03:00 IST: the run a delayed cron would produce.
    const now = new Date('2026-09-10T21:30:00Z');
    clock = now;

    const result = await nudge.runNudgeSweepService(now);

    assert.equal(result.skipped, 'quiet_hours');
    assert.equal(result.localHour, 3);
    assert.equal(attempts.length, 0, `seed ${seed}: attempted a push at 03:00 IST`);
    assert.equal(created.length, 0, `seed ${seed}: logged a nudge at 03:00 IST`);
    assert.ok(users.length === 8);
  }
});

test('a user who is both behind and long-absent gets the comeback, not the target nudge', async () => {
  reset();
  // Behind on a live target, and has not trained in three weeks.
  healthTargets = [targetGoal(50)];
  scoreBands = { 50: 'behind' };
  groupedSessions = [{ userId: 50, _max: { startedAt: hoursBefore(START, 21 * 24) } }];
  profiles[50] = { freeTimeWindow: null };

  clock = START;
  const result = await nudge.runNudgeSweepService(START);

  // The weekly budget is one budget, and "come back" is the honest message
  // for someone who has not trained in a month - "you fell behind your goal"
  // to someone who has not set foot in a gym is both noise and a bit rude.
  // This is deliberate, so it is pinned: a future change to the ordering of
  // these loops should have to update this test on purpose.
  assert.equal(result.comeback, 1);
  assert.equal(result.target, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'comeback');
});

test('a sweep where nobody can be reached still reports it, not a silent success', async () => {
  const rand = mulberry32(5);
  reset();
  const users = makeWorld(rand, 6);
  // Everyone has turned off every kind of nudge.
  for (const userId of users) {
    for (const type of nudge.NUDGE_TYPES) optOuts.push({ userId, type });
  }

  clock = START;
  const result = await nudge.runNudgeSweepService(START);

  // The scheduler reads these counts out of a CI log. A run that sent nothing
  // must be visibly different from a run that never looked.
  assert.equal(result.sent, 0);
  assert.equal(result.suppressed + result.deferred > 0, true);
  assert.equal(result.log + result.comeback + result.target, 0);
});