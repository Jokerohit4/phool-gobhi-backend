// FR-08. This is the only code in the programme that contacts a user
// unprompted, so the tests are about restraint rather than delivery: the
// failure mode is not a wrong pixel, it is a push notification to a real
// person at three in the morning.
//
// The properties pinned here:
//   - quiet hours are checked by the SERVICE, not trusted to the cron
//   - the weekly cap counts every nudge type together, not each alone
//   - a nudge that failed to send is not logged (and so does not burn the
//     user's weekly budget on something they never saw)
//   - an opt-out outranks everything
//   - "comeback" excludes people who never logged and people long churned
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 12:00 IST on a Thursday, expressed in UTC (IST = UTC+5:30). Every date in
// this suite is derived from this instant.
const FIXED_NOW = new Date('2026-09-10T06:30:00Z');

let optOuts = [];
let nudgeLogs = [];
let created = [];
let groupedSessions = [];
let sent = [];
let sendResult = true;
let unloggedUsers = [];
// auth-service profiles by userId, for comeback free-time timing.
let profiles = {};
// HealthGoal rows the target-candidate query sees, and the band the (mocked)
// target engine would compute for each user.
let healthTargets = [];
let scoreBands = {};

let nudge;

// Offsets are measured from the SAME fixed clock the assertions inject,
// never from Date.now(). Mixing the two made this suite time-of-day
// dependent: "30 hours ago" sat 28.5h before the fixed midday when the
// suite ran in the morning and 22.5h before it in the afternoon, so the
// 24-hour guard flipped and the run failed after lunch. A test whose
// result depends on when you run it is worse than no test.
function daysAgo(n, from = FIXED_NOW) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000);
}

function hoursAgo(n, from = FIXED_NOW) {
  return new Date(from.getTime() - n * 60 * 60 * 1000);
}

test('setup: mock prisma, FCM and the unlogged feed once', async (t) => {
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
            upsert: async ({ create }) => {
              optOuts.push(create);
              return create;
            },
            deleteMany: async ({ where }) => {
              optOuts = optOuts.filter(
                (o) => !(o.userId === where.userId && o.type === where.type),
              );
              return { count: 1 };
            },
          };
          this.nudgeLog = {
            findMany: async ({ where }) =>
              nudgeLogs
                .filter((l) => l.userId === where.userId && l.sentAt >= where.sentAt.gte)
                .sort((a, b) => b.sentAt - a.sentAt),
            create: async ({ data }) => {
              const row = { ...data, sentAt: data.sentAt ?? new Date() };
              created.push(row);
              nudgeLogs.push(row);
              return row;
            },
          };
          this.workoutSession = {
            groupBy: async () => groupedSessions,
            findMany: async () => [],
          };
          // Mirrors the real where clause: a target must exist, still be open
          // and not be under calm mode to be a candidate at all.
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
        sent.push({ userId, payload });
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

  // The band the user's own card would show. Mocked so the sweep's DECISION to
  // nudge is what is under test, not the score engine's already-tested pace
  // maths.
  t.mock.module('../services/ledger/scoreTargetService.js', {
    exports: {
      getScoreTargetState: async (_prisma, { userId }) => ({
        band: scoreBands[userId] ?? 'on_track',
      }),
    },
  });

  nudge = await import('../services/nudgeService.js');
});

function reset() {
  optOuts = [];
  nudgeLogs = [];
  created = [];
  groupedSessions = [];
  sent = [];
  sendResult = true;
  unloggedUsers = [];
  profiles = {};
  healthTargets = [];
  scoreBands = {};
}

// An IST day `offset` days from the fixed clock, 'YYYY-MM-DD'. Positive is the
// future; the target window is stored in these strings.
function isoDay(offset, from = FIXED_NOW) {
  return new Date(from.getTime() + offset * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
}

// A HealthGoal row with a live target, overridable per test.
function targetGoal(userId, overrides = {}) {
  return {
    userId,
    scoreTargetPoints: 400,
    scoreTargetFrom: isoDay(-5),
    scoreTargetUntil: isoDay(10),
    calmMode: false,
    pausedFrom: null,
    pausedUntil: null,
    ...overrides,
  };
}

const middayIST = FIXED_NOW;
const nightIST = new Date('2026-09-10T21:30:00Z');

test('quiet hours are decided by the service, not by the schedule', () => {
  assert.equal(nudge.isQuietHours(middayIST), false);
  assert.equal(nudge.isQuietHours(nightIST), true);
  // The boundaries themselves: 22:00 is quiet, 09:00 is not.
  assert.equal(nudge.isQuietHours(new Date('2026-09-10T16:30:00Z')), true); // 22:00 IST
  assert.equal(nudge.isQuietHours(new Date('2026-09-10T03:30:00Z')), false); // 09:00 IST
});

test('a sweep that fires inside quiet hours sends nothing', async () => {
  reset();
  unloggedUsers = [{ userId: 1, localDate: '2026-09-10' }];

  const result = await nudge.runNudgeSweepService(nightIST);

  assert.equal(result.skipped, 'quiet_hours');
  assert.equal(sent.length, 0, 'a delayed cron must not become a 03:00 push');
});

test('an opt-out outranks everything else', async () => {
  reset();
  optOuts = [{ userId: 1, type: 'log' }];

  const { allowed, reason } = await nudge.canSendService(1, 'log', middayIST);

  assert.equal(allowed, false);
  assert.equal(reason, 'opted_out');
});

test('the weekly cap counts every type together', async () => {
  reset();
  // Three nudges this week, of mixed types, all older than the 24h gap.
  nudgeLogs = [
    { userId: 1, type: 'log', sentAt: daysAgo(2) },
    { userId: 1, type: 'comeback', sentAt: daysAgo(4) },
    { userId: 1, type: 'log', sentAt: daysAgo(6) },
  ];

  const { allowed, reason } = await nudge.canSendService(1, 'log', middayIST);

  // Three different reminders is still three notifications to the person
  // receiving them.
  assert.equal(allowed, false);
  assert.equal(reason, 'weekly_cap');
});

test('two nudges never land within 24 hours', async () => {
  reset();
  nudgeLogs = [{ userId: 1, type: 'log', sentAt: hoursAgo(5) }];

  const tooSoon = await nudge.canSendService(1, 'comeback', middayIST);
  assert.equal(tooSoon.allowed, false);
  assert.equal(tooSoon.reason, 'too_soon');

  reset();
  nudgeLogs = [{ userId: 1, type: 'log', sentAt: hoursAgo(30) }];
  assert.equal((await nudge.canSendService(1, 'comeback', middayIST)).allowed, true);
});

test('a sweep sends the log nudge and records it', async () => {
  reset();
  unloggedUsers = [{ userId: 7, localDate: '2026-09-10', gymId: 3 }];

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.log, 1);
  assert.equal(result.sent, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'log');
});

test('the payload carries routing keys only, never session detail', async () => {
  reset();
  unloggedUsers = [{ userId: 7, localDate: '2026-09-10', gymId: 3 }];

  await nudge.runNudgeSweepService(middayIST);

  const { payload } = sent[0];
  // A notification is rendered by the OS on a lock screen.
  assert.deepEqual(Object.keys(payload.data).sort(), ['nudge', 'route', 'type']);
  const serialised = JSON.stringify(payload);
  assert.ok(!serialised.includes('gymId'), 'no gym in an FCM payload');
  assert.ok(!/\bkg\b/.test(serialised), 'no measurements in an FCM payload');
});

test('a nudge that failed to send is not logged against the weekly budget', async () => {
  reset();
  sendResult = false; // e.g. the user has no FCM token
  unloggedUsers = [{ userId: 7, localDate: '2026-09-10' }];

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.sent, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(created.length, 0, 'an unseen notification must not cost a slot');
});

test('the comeback nudge targets people who logged before and went quiet', async () => {
  reset();
  groupedSessions = [
    // Quiet for 10 days: the target.
    { userId: 1, _max: { startedAt: daysAgo(10) } },
    // Trained yesterday: not lapsed.
    { userId: 2, _max: { startedAt: daysAgo(1) } },
    // Gone for four months: churned, and a push is an intrusion.
    { userId: 3, _max: { startedAt: daysAgo(120) } },
    // Never finished a session at all.
    { userId: 4, _max: { startedAt: null } },
  ];

  const candidates = await nudge.findComebackCandidatesService(middayIST);

  assert.deepEqual(candidates, [1]);
});

test('free-time windows map to IST hours, and "late nights" stops at quiet hours', () => {
  // 12:00 IST.
  assert.equal(nudge.isWithinFreeTime('afternoon', middayIST), true);
  assert.equal(nudge.isWithinFreeTime('morning', middayIST), false);
  assert.equal(nudge.isWithinFreeTime('evening', middayIST), false);
  // No answer / "it varies" / unknown: any time in the sending day.
  assert.equal(nudge.isWithinFreeTime(null, middayIST), true);
  assert.equal(nudge.isWithinFreeTime('flexible', middayIST), true);
  assert.equal(nudge.isWithinFreeTime('whenever', middayIST), true);
  // 21:00 IST is the last sweep before quiet hours: late nights lands there.
  const ninePmIST = new Date('2026-09-10T15:30:00Z');
  assert.equal(nudge.isWithinFreeTime('late_night', ninePmIST), true);
  assert.equal(nudge.isWithinFreeTime('late_night', middayIST), false);
  // Every window stays inside the sending day, so quiet hours always win.
  for (const [from, to] of Object.values(nudge.FREE_TIME_HOURS)) {
    assert.ok(from >= nudge.QUIET_END_HOUR && to <= nudge.QUIET_START_HOUR);
  }
});

test('a comeback nudge waits for the user\'s free time without spending budget', async () => {
  reset();
  groupedSessions = [
    { userId: 1, _max: { startedAt: daysAgo(10) } },
    { userId: 2, _max: { startedAt: daysAgo(10) } },
  ];
  profiles = { 1: { freeTimeWindow: 'evening' }, 2: { freeTimeWindow: 'afternoon' } };

  const result = await nudge.runNudgeSweepService(middayIST);

  // User 2 is free at midday and gets it; user 1 is deferred to the evening.
  assert.equal(result.comeback, 1);
  assert.equal(result.deferred, 1);
  assert.deepEqual(sent.map((s) => s.userId), [2]);
  assert.deepEqual(created.map((c) => c.userId), [2]);
});

test('an unreachable auth-service means no preference, not no nudge', async () => {
  reset();
  groupedSessions = [{ userId: 1, _max: { startedAt: daysAgo(10) } }];
  profiles = {};

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.comeback, 1);
  assert.equal(result.deferred, 0);
});

test('the target nudge asks for the band, and only "behind" earns a send', async () => {
  reset();
  healthTargets = [
    targetGoal(1), // behind below - the one candidate
    targetGoal(2, { calmMode: true }), // calm mode: excluded before scoring
    targetGoal(3, { pausedFrom: isoDay(-2), pausedUntil: isoDay(2) }), // mid-pause
    targetGoal(4, { scoreTargetFrom: isoDay(3) }), // window not open yet
    targetGoal(5), // on track
    targetGoal(6), // window already closed
  ];
  // The closed window is filtered by the SQL mock; give it a past `until`.
  healthTargets[5].scoreTargetUntil = isoDay(-1);
  scoreBands = { 1: 'behind', 5: 'on_track' };

  const candidates = await nudge.findTargetCandidatesService(middayIST);

  // Calm mode and a paused goal never reach the engine; a target that has not
  // opened is not behind; on_track is not behind. only user 1 is left.
  assert.deepEqual(candidates, [1]);
});

test('a sweep sends the target nudge, records it, and routes to the score', async () => {
  reset();
  healthTargets = [targetGoal(7)];
  scoreBands = { 7: 'behind' };
  profiles = { 7: { freeTimeWindow: 'afternoon' } };

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.target, 1);
  assert.equal(result.sent, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 'target');
  assert.equal(sent[0].payload.data.route, 'score');
});

test('the target nudge waits for free time without spending budget', async () => {
  reset();
  healthTargets = [targetGoal(7)];
  scoreBands = { 7: 'behind' };
  profiles = { 7: { freeTimeWindow: 'evening' } };

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.target, 0);
  assert.equal(result.deferred, 1);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
});

test('a repeated target nudge is held back longer than other nudges', async () => {
  reset();
  // 48h after a target nudge: past the global 24h gap, inside the 72h floor.
  nudgeLogs = [{ userId: 1, type: 'target', sentAt: hoursAgo(48) }];

  const held = await nudge.canSendService(1, 'target', middayIST);
  assert.equal(held.allowed, false);
  assert.equal(held.reason, 'target_cooldown');

  // The longer floor is per type: another type at 48h is only bound by the
  // 24h gap.
  assert.equal((await nudge.canSendService(1, 'comeback', middayIST)).allowed, true);

  // And the target nudge is allowed again once its own floor has passed.
  reset();
  nudgeLogs = [{ userId: 1, type: 'target', sentAt: hoursAgo(80) }];
  assert.equal((await nudge.canSendService(1, 'target', middayIST)).allowed, true);
});

test('opting out and back in round-trips', async () => {
  reset();

  assert.deepEqual(await nudge.setOptOutService(5, 'log', true), ['log']);
  assert.deepEqual(await nudge.setOptOutService(5, 'log', false), []);
});

test('the target nudge is independently switchable', async () => {
  reset();

  // A user who wants the pace reminder off must not have to also silence
  // comeback, and vice versa.
  assert.deepEqual(await nudge.setOptOutService(5, 'target', true), ['target']);
  assert.equal(nudge.NUDGE_TYPES.includes('target'), true);
});

test('an unknown nudge type is rejected rather than silently stored', async () => {
  reset();
  await assert.rejects(() => nudge.setOptOutService(5, 'marketing', true), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});
