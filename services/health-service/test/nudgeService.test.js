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
import fs from 'node:fs';

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
// Which users the target engine was actually asked about. Proves the SQL
// excluded a user before any scoring happened, rather than scoring them and
// discarding the answer.
let scored = [];

// Lifecycle feed: recent signups (as auth-service reports them), their
// activity rows, and workout sessions; plus captured analytics events.
let lifecycleCandidates = [];
let lifecycleActivity = [];
let lifecycleSessions = [];
let tracked = [];

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
            findFirst: async ({ where }) =>
              nudgeLogs.find(
                (l) =>
                  l.userId === where.userId &&
                  l.type === where.type &&
                  (!where.sentAt || l.sentAt >= where.sentAt.gte),
              ) ?? null,
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
            groupBy: async ({ where }) => {
              // The lifecycle activity query is scoped by userId; the comeback
              // query is not.
              if (!where?.userId) return groupedSessions;
              return lifecycleSessions
                .filter((r) => where.userId.in.includes(r.userId) && (!where.endedAt || r.ended))
                .map((r) => ({ userId: r.userId, _max: { startedAt: r.startedAt } }));
            },
            findMany: async () => [],
          };
          for (const [model, field] of [
            ['waterLog', 'water'], ['foodLog', 'food'],
            ['planItemCompletion', 'plan'], ['wellnessMoodCheckIn', 'mood'],
          ]) {
            this[model] = {
              groupBy: async ({ where }) =>
                lifecycleActivity
                  .filter((r) => r.kind === field && where.userId.in.includes(r.userId))
                  .map((r) => ({ userId: r.userId, _max: { createdAt: r.at } })),
            };
          }
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

  t.mock.module('../utils/fetchLifecycleCandidates.js', {
    exports: { fetchLifecycleCandidates: async () => lifecycleCandidates },
  });

  t.mock.module('../utils/analytics.js', {
    exports: { track: (name, userId, props) => tracked.push({ name, userId, props }) },
  });

  t.mock.module('../utils/fetchUserProfile.js', {
    exports: { fetchUserProfileInternal: async (userId) => profiles[userId] ?? null },
  });

  // The band the user's own card would show. Mocked so the sweep's DECISION to
  // nudge is what is under test, not the score engine's already-tested pace
  // maths.
  t.mock.module('../services/ledger/scoreTargetService.js', {
    exports: {
      getScoreTargetState: async (_prisma, { userId }) => {
        scored.push(userId);
        return { band: scoreBands[userId] ?? 'on_track' };
      },
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
  scored = [];
  lifecycleCandidates = [];
  lifecycleActivity = [];
  lifecycleSessions = [];
  tracked = [];
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

test('calm-mode and paused users are never scored, not scored-then-dropped', async () => {
  reset();
  healthTargets = [
    targetGoal(1),
    targetGoal(2, { calmMode: true }),
    targetGoal(3, { pausedFrom: isoDay(-2), pausedUntil: isoDay(2) }),
    targetGoal(4, { scoreTargetFrom: isoDay(3) }),
  ];
  scoreBands = { 1: 'behind', 2: 'behind', 3: 'behind', 4: 'behind' };

  await nudge.findTargetCandidatesService(middayIST);

  // Every one of these rows would have produced a nudge had the band been
  // read. They never reach the engine at all, so there is no path by which a
  // future change to the band maths can start nudging someone in calm mode.
  assert.deepEqual(scored, [1]);
});

test('only the behind band earns a target nudge', async () => {
  for (const band of ['at_risk', 'reached', 'expired', 'none', 'on_track']) {
    reset();
    healthTargets = [targetGoal(1)];
    scoreBands = { 1: band };

    const result = await nudge.runNudgeSweepService(middayIST);

    // `at_risk` is the interesting one: a real, honest shortfall the product
    // chose to keep quiet about. `reached` and `expired` have nothing left to
    // pace towards at all.
    assert.equal(result.target, 0, `${band} must not send`);
    assert.equal(sent.length, 0);
  }
});

test('a window closing today is still in play, one that closed yesterday is not', () => {
  reset();
  const today = isoDay(0);
  healthTargets = [
    targetGoal(1, { scoreTargetUntil: today }), // gte, so today is inside
    targetGoal(2, { scoreTargetUntil: isoDay(-1) }),
  ];
  scoreBands = { 1: 'behind', 2: 'behind' };

  // This is the mock standing in for the SQL `gte`. The real string comparison
  // is pinned in nudgeDb.test.js against a live database.
  return nudge.findTargetGoalRowsService(middayIST).then((rows) => {
    assert.deepEqual(rows.map((r) => r.userId), [1]);
  });
});

test('a goal with no scoreTargetFrom is treated as an open window', () => {
  reset();
  healthTargets = [
    targetGoal(1, { scoreTargetFrom: null }),
    targetGoal(2, { scoreTargetFrom: isoDay(1) }),
  ];
  scoreBands = { 1: 'behind', 2: 'behind' };

  return nudge.findTargetGoalRowsService(middayIST).then((rows) => {
    // Absent is not "not started": only an explicit future date defers.
    assert.deepEqual(rows.map((r) => r.userId), [1]);
  });
});

test('an opt-out on the target nudge suppresses it and is counted as suppressed', async () => {
  reset();
  optOuts = [{ userId: 7, type: 'target' }];
  healthTargets = [targetGoal(7)];
  scoreBands = { 7: 'behind' };

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.target, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
});

test('a live cooldown suppresses the target nudge inside a sweep', async () => {
  reset();
  nudgeLogs = [{ userId: 7, type: 'target', sentAt: hoursAgo(30) }];
  healthTargets = [targetGoal(7)];
  scoreBands = { 7: 'behind' };

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.target, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(created.length, 0, 'a suppressed nudge must not be logged');
});

test('a target nudge spends the same weekly budget as any other', async () => {
  reset();
  // Two log nudges and one target nudge this week: the fourth is refused
  // whichever type it is, because the cap counts notifications, not kinds.
  nudgeLogs = [
    { userId: 1, type: 'log', sentAt: daysAgo(1) },
    { userId: 1, type: 'target', sentAt: daysAgo(3) },
    { userId: 1, type: 'log', sentAt: daysAgo(5) },
  ];

  assert.equal((await nudge.canSendService(1, 'log', middayIST)).reason, 'weekly_cap');
  assert.equal((await nudge.canSendService(1, 'comeback', middayIST)).reason, 'weekly_cap');
  assert.equal((await nudge.canSendService(1, 'target', middayIST)).reason, 'weekly_cap');
});

test('every nudge type has copy, and the payload carries nothing but routing keys', async () => {
  for (const type of nudge.NUDGE_TYPES) {
    reset();
    // Only the source for THIS nudge, so it is the only one that can fire:
    // a user set up for all three would have the first nudge consume the
    // 24h gap and leave the other two unfindable.
    unloggedUsers = type === 'log' ? [{ userId: 3, localDate: '2026-09-10' }] : [];
    groupedSessions = type === 'comeback' ? [{ userId: 3, _max: { startedAt: daysAgo(10) } }] : [];
    healthTargets = type === 'target' ? [targetGoal(3)] : [];
    scoreBands = { 3: 'behind' };

    await nudge.runNudgeSweepService(middayIST);

    const mine = sent.find((s) => s.payload.data.nudge === type);
    assert.ok(mine, `${type} produced no payload`);
    assert.ok(mine.payload.title?.length > 0, `${type} has no title`);
    assert.ok(mine.payload.body?.length > 0, `${type} has no body`);
    assert.ok(mine.payload.data.route?.length > 0, `${type} has no route to open`);
    // Same rule for all three: nothing about the user goes to Google.
    assert.deepEqual(Object.keys(mine.payload.data).sort(), ['nudge', 'route', 'type']);
  }
});

test('the wire enum and the service type list cannot drift apart', () => {
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const enumBody = schema.match(/enum NudgeType\s*\{([^}]*)\}/)?.[1];

  assert.ok(enumBody, 'NudgeType not found in the schema - rename or the guard is dead');

  const values = enumBody
    // CRLF-safe: `.` in JS does not match `\r`, so a naive `//.*$` strip
    // leaves the comment in place on a Windows checkout and the guard then
    // "fails" on its own comment.
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l && !l.startsWith('@@'));

  // setOptOutService validates against NUDGE_TYPES, and the enum is what
  // Postgres will accept. A type in one and not the other is a 400 in the
  // settings screen or an "invalid input value for enum" at write time, and
  // both only show up once a real user taps the switch.
  assert.deepEqual(values.sort(), [...nudge.OPT_OUT_TYPES, ...nudge.LIFECYCLE_TYPES].sort());
});

test('localDateIST turns over exactly at 4 AM IST', () => {
  // 18:29 UTC is 23:59 IST the same day; 18:30 is 00:00 the next. The whole
  // target window is compared against this string, so an off-by-one here moves
  // every user's window by a day.
  assert.equal(nudge.localDateIST(new Date('2026-09-10T22:29:00Z')), '2026-09-10');
  assert.equal(nudge.localDateIST(new Date('2026-09-10T22:30:00Z')), '2026-09-11');
});

test('quiet hours is exactly the block the constants describe', () => {
  // Every hour of the IST day, built from UTC so no test depends on the
  // machine's own zone. A "quiet hours" rule that is not one contiguous block
  // is a rule nobody can predict.
  const at = (istHour) =>
    // IST is UTC+5:30, so an IST hour maps to UTC at (hour - 5h30). Written
    // as minute -30 because Date.UTC normalises the borrow; `hour - 5` with
    // minute 30 would be 09:00 when asked for 08:00.
    new Date(Date.UTC(2026, 8, 10, istHour - 5, -30));

  for (let hour = 0; hour < 24; hour += 1) {
    assert.equal(
      nudge.isQuietHours(at(hour)),
      hour >= nudge.QUIET_START_HOUR || hour < nudge.QUIET_END_HOUR,
      `${hour}:00 IST`,
    );
  }
});

test('an unknown nudge type is rejected rather than silently stored', async () => {
  reset();
  await assert.rejects(() => nudge.setOptOutService(5, 'marketing', true), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Lifecycle nudges (2026-11-23): the first-week gap. These are the rules that
// keep a brand-new user from being nagged or double-sent.
// ---------------------------------------------------------------------------

// A recent signup as auth-service reports it. `ageHours` is measured from the
// fixed clock.
function signup(id, ageHours, overrides = {}) {
  return {
    id,
    createdAt: hoursAgo(ageHours),
    hasToken: true,
    onboardingComplete: true,
    freeTimeWindow: null,
    ...overrides,
  };
}

const NO_ACTIVITY = { last: null, completedWorkout: false };

test('lifecycle timing table: who is due which nudge', () => {
  const stage = (c, a = NO_ACTIVITY) => nudge.lifecycleStageFor(c, a, FIXED_NOW);

  // Incomplete onboarding: resume between 3h and 48h, then never.
  const inc = (h) => stage(signup(1, h, { onboardingComplete: false }));
  assert.equal(inc(1), null);
  assert.equal(inc(3).type, 'onboarding_resume');
  assert.equal(inc(47).type, 'onboarding_resume');
  assert.equal(inc(49), null);

  // Onboarded, nothing done: first step 24-72h, follow-up 72h-7d.
  assert.equal(stage(signup(1, 23)), null);
  assert.equal(stage(signup(1, 24)).type, 'first_step');
  assert.equal(stage(signup(1, 71)).type, 'first_step');
  assert.equal(stage(signup(1, 72)).type, 'first_step_followup');
  assert.equal(stage(signup(1, 24 * 6)).type, 'first_step_followup');

  // Past a week with nothing ever: the soft comeback, up to the 60-day cutoff.
  assert.deepEqual(stage(signup(1, 24 * 8)), { type: 'comeback', variant: 'soft' });
  assert.equal(stage(signup(1, 24 * 61)), null);
});

test('lifecycle: any activity counts, and a finished workout hands over to the existing comeback', () => {
  const stage = (a, ageHours = 50) => nudge.lifecycleStageFor(signup(1, ageHours), a, FIXED_NOW);

  // Did one small thing yesterday: no first-step push at all.
  assert.equal(stage({ last: hoursAgo(20), completedWorkout: false }), null);
  // Active, then quiet 10 days: soft comeback. 3 days quiet: nothing.
  assert.deepEqual(stage({ last: daysAgo(10), completedWorkout: false }, 24 * 20), { type: 'comeback', variant: 'soft' });
  assert.equal(stage({ last: daysAgo(3), completedWorkout: false }, 24 * 20), null);
  // Churned (quiet 90 days): not a comeback.
  assert.equal(stage({ last: daysAgo(90), completedWorkout: false }, 24 * 100), null);
  // Completed a workout once: owned by the workout comeback, never both.
  assert.equal(stage({ last: daysAgo(10), completedWorkout: true }, 24 * 20), null);
});

test('sweep sends first_step once, records it, emits nudge_sent without PII', async () => {
  reset();
  lifecycleCandidates = [signup(5, 30)];

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.first_step, 1);
  assert.equal(result.sent, 1);
  assert.deepEqual(created.map((c) => [c.userId, c.type]), [[5, 'first_step']]);
  assert.equal(sent[0].payload.data.nudge, 'first_step');
  assert.deepEqual(Object.keys(sent[0].payload.data).sort(), ['nudge', 'route', 'type']);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].name, 'nudge_sent');
  assert.deepEqual(tracked[0].props, { nudge_type: 'first_step', hours_since_signup: 30 });
  // Founder rule: a first step never pushes a workout.
  assert.ok(!/work ?out|train|session/i.test(sent[0].payload.title + ' ' + sent[0].payload.body));
});

test('lifecycle nudges are never repeated, even weeks later', async () => {
  reset();
  lifecycleCandidates = [signup(5, 30)];
  nudgeLogs = [{ userId: 5, type: 'first_step', sentAt: daysAgo(20) }];

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.first_step, 0);
  assert.equal(created.length, 0);
});

test('a double run of the sweep sends a lifecycle nudge once', async () => {
  reset();
  lifecycleCandidates = [signup(5, 30)];

  await nudge.runNudgeSweepService(middayIST);
  await nudge.runNudgeSweepService(middayIST);

  assert.equal(sent.length, 1);
});

test('lifecycle: users without an FCM token are counted as no_token and never sent', async () => {
  reset();
  lifecycleCandidates = [
    signup(1, 30),
    signup(2, 30, { hasToken: false }),
    signup(3, 10, { hasToken: false, onboardingComplete: false }),
    // Not due anything: must not be counted as an unreachable nudge target.
    signup(4, 5, { hasToken: false }),
  ];

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.first_step, 1);
  assert.equal(result.lifecycle_no_token, 2);
  assert.deepEqual(sent.map((s) => s.userId), [1]);
  assert.equal(created.length, 1, 'an unreachable user must not burn a log row');
  // Token coverage over every recent signup the sweep saw.
  assert.deepEqual(result.lifecycle_coverage, {
    candidates: 4, withToken: 1, onboarded: 3, onboardedWithToken: 1,
  });
});

test('lifecycle: opt-out (one switch for all three), weekly cap, 24h gap and free time all apply', async () => {
  reset();
  lifecycleCandidates = [
    signup(1, 30),                                        // opted out of lifecycle
    signup(2, 30),                                        // another nudge 5h ago
    signup(3, 30, { freeTimeWindow: 'evening' }),         // free later, now is midday
    signup(4, 30),                                        // control: sent
  ];
  optOuts = [{ userId: 1, type: 'lifecycle' }];
  nudgeLogs = [{ userId: 2, type: 'log', sentAt: hoursAgo(5) }];

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.first_step, 1);
  assert.deepEqual(sent.map((s) => s.userId), [4]);
  assert.equal(result.deferred, 1);

  // Weekly cap counts lifecycle sends with everything else.
  reset();
  lifecycleCandidates = [signup(9, 30)];
  nudgeLogs = [
    { userId: 9, type: 'log', sentAt: daysAgo(2) },
    { userId: 9, type: 'comeback', sentAt: daysAgo(4) },
    { userId: 9, type: 'log', sentAt: daysAgo(6) },
  ];
  assert.equal((await nudge.runNudgeSweepService(middayIST)).first_step, 0);
});

test('lifecycle: the sweep reads real activity rows (water, mood, plan tick, workout)', async () => {
  reset();
  lifecycleCandidates = [signup(1, 30), signup(2, 30), signup(3, 30), signup(4, 30), signup(5, 30)];
  lifecycleActivity = [
    { userId: 1, kind: 'water', at: hoursAgo(10) },
    { userId: 2, kind: 'mood', at: hoursAgo(10) },
    { userId: 3, kind: 'plan', at: hoursAgo(10) },
  ];
  lifecycleSessions = [{ userId: 4, startedAt: hoursAgo(10), ended: false }];

  const result = await nudge.runNudgeSweepService(middayIST);

  // Only user 5 did nothing at all.
  assert.deepEqual(sent.map((s) => s.userId), [5]);
  assert.equal(result.first_step, 1);
});

test('generalised comeback: soft variant for never-finished-a-workout, cooled down for 14 days', async () => {
  reset();
  // User 1 was active 10 days ago (water), never finished a workout.
  lifecycleCandidates = [signup(1, 24 * 20)];
  lifecycleActivity = [{ userId: 1, kind: 'water', at: daysAgo(10) }];

  const first = await nudge.runNudgeSweepService(middayIST);
  assert.equal(first.comeback_soft, 1);
  assert.equal(created[0].type, 'comeback');
  const body = sent[0].payload.title + ' ' + sent[0].payload.body;
  assert.ok(!/work ?out|session|train/i.test(body), 'soft comeback never asks for a workout');
  assert.equal(tracked[0].props.variant, 'soft');

  // Eight days later it is still quiet: inside the 14-day cooldown, no repeat.
  const later = new Date(FIXED_NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
  const second = await nudge.runNudgeSweepService(later);
  assert.equal(second.comeback_soft, 0);
});

test('a user who finished a workout is left to the workout comeback, not the soft one', async () => {
  reset();
  lifecycleCandidates = [signup(1, 24 * 20)];
  lifecycleActivity = [{ userId: 1, kind: 'water', at: daysAgo(10) }];
  lifecycleSessions = [{ userId: 1, startedAt: daysAgo(10), ended: true }];

  const result = await nudge.runNudgeSweepService(middayIST);

  assert.equal(result.comeback_soft, 0);
  assert.equal(sent.length, 0);
});

test('lifecycle sends respect quiet hours', async () => {
  reset();
  lifecycleCandidates = [signup(1, 30)];
  const result = await nudge.runNudgeSweepService(nightIST);
  assert.equal(result.skipped, 'quiet_hours');
  assert.equal(sent.length, 0);
});

test('one lifecycle opt-out row is accepted by settings and listed', async () => {
  reset();
  assert.deepEqual(await nudge.setOptOutService(1, 'lifecycle', true), ['lifecycle']);
  assert.ok(nudge.OPT_OUT_TYPES.includes('lifecycle'));
  // The three sendable types are unchanged.
  assert.deepEqual(nudge.NUDGE_TYPES, ['log', 'comeback', 'target']);
});
