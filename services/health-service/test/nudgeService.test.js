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

let optOuts = [];
let nudgeLogs = [];
let created = [];
let groupedSessions = [];
let sent = [];
let sendResult = true;
let unloggedUsers = [];

let nudge;

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000);
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
}

// 12:00 and 03:00 IST, expressed in UTC (IST = UTC+5:30).
const middayIST = new Date('2026-09-10T06:30:00Z');
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

test('opting out and back in round-trips', async () => {
  reset();

  assert.deepEqual(await nudge.setOptOutService(5, 'log', true), ['log']);
  assert.deepEqual(await nudge.setOptOutService(5, 'log', false), []);
});

test('an unknown nudge type is rejected rather than silently stored', async () => {
  reset();
  await assert.rejects(() => nudge.setOptOutService(5, 'marketing', true), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});
