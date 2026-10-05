// Real-database tests for the target nudge's candidate query.
//
// Everything else in this suite mocks Prisma. That is fine for logic and wrong
// for this one thing: `scoreTargetUntil` is a TEXT column holding 'YYYY-MM-DD'
// and is compared with `gte` against a string that Node produced. A hand-written
// mock agrees with that by construction, so it cannot catch the two failures
// that would actually ship:
//
//   - a text comparison that sorts differently to the ISO strings we assume
//     ('2026-9-1' vs '2026-09-01', or a collation that ignores punctuation)
//   - an enum value the service offers that Postgres will refuse, which only
//     appears when a real user taps the switch in the settings screen
//
// So this file runs the same query against a real Postgres. It is skipped
// unless TEST_DATABASE_URL is set, so `npm test` still runs anywhere; CI starts
// a Postgres service and runs migrations before this.
//
// Run with:
//   TEST_DATABASE_URL=postgres://... npx prisma migrate deploy
//   node --experimental-test-module-mocks --test test/nudgeDb.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = process.env.TEST_DATABASE_URL?.trim();
const SKIP = TEST_URL
  ? false
  : 'set TEST_DATABASE_URL (and run `prisma migrate deploy` against it) to run these';

// The service builds its PrismaClient at import time from DATABASE_URL, so the
// swap has to happen before the import rather than being passed to the
// constructor from the outside.
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

// A range no real user can be in. Everything written here is removed again in
// the `after` hook, and the ids are chosen so that a crashed run cannot
// collide with a person.
const BASE = 9_100_000;

// `today` for the test is fixed rather than "now": a query that compares date
// strings cannot be tested against a moving target, and the interesting cases
// are all on the boundary anyway.
const NOW = new Date('2026-09-10T06:30:00Z'); // 12:00 IST
const TODAY = '2026-09-10';

const day = (offset) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/// One HealthGoal row. Only userId, goal and startDate are required by the
/// schema; everything the query touches is set here.
function row(id, overrides = {}) {
  return {
    userId: BASE + id,
    // `goals`, an array - not the scalar `goal` this fixture used to set. The
    // field became a ranked list in the multi-goal migration and this fixture was
    // never updated, so every createMany in this file threw
    // "Unknown argument `goal`. Did you mean `goals`?" against a real database.
    // The mock-based nudge tests cannot catch that, because a mock accepts any
    // shape it is handed - which is why this file exists at all, and why it had
    // rotted unnoticed in the one place that could have shown it.
    goals: ['build_muscle'],
    startDate: day(-30),
    scoreTargetPoints: 400,
    scoreTargetFrom: day(-10),
    scoreTargetUntil: day(10),
    calmMode: false,
    pausedFrom: null,
    pausedUntil: null,
    ...overrides,
  };
}

// id -> what it is proving. Named rather than numbered so a failure names the
// case instead of a number.
const CASES = {
  live: row(1),
  untilToday: row(2, { scoreTargetUntil: day(0) }),
  noFrom: row(3, { scoreTargetFrom: null }),
  pauseEndedYesterday: row(4, { pausedFrom: day(-3), pausedUntil: day(-1) }),

  untilYesterday: row(5, { scoreTargetUntil: day(-1) }),
  untilLastYear: row(6, { scoreTargetUntil: day(-365) }),
  noTargetPoints: row(7, { scoreTargetPoints: null }),
  calmMode: row(8, { calmMode: true }),
  pausedToday: row(9, { pausedFrom: day(-1), pausedUntil: day(1) }),
  pausedFromToday: row(10, { pausedFrom: day(0), pausedUntil: day(3) }),
  startsTomorrow: row(11, { scoreTargetFrom: day(1) }),
};

const INCLUDED = ['live', 'untilToday', 'noFrom', 'pauseEndedYesterday'];
const EXCLUDED = [
  'untilYesterday',
  'untilLastYear',
  'noTargetPoints',
  'calmMode',
  'pausedToday',
  'pausedFromToday',
  'startsTomorrow',
];

let prisma;
let nudge;

before(async () => {
  if (SKIP) return;
  const mod = await import('@prisma/client');
  prisma = new mod.PrismaClient();
  nudge = await import('../services/nudgeService.js');
});

after(async () => {
  if (!prisma) return;
  await prisma.nudgeOptOut.deleteMany({ where: { userId: { gte: BASE } } });
  await prisma.healthGoal.deleteMany({ where: { userId: { gte: BASE } } });
  await prisma.$disconnect();
});

test('the candidate query returns exactly the goals whose window is open today', { skip: SKIP }, async () => {
  await prisma.healthGoal.createMany({ data: Object.values(CASES) });

  const rows = await nudge.findTargetGoalRowsService(NOW);
  const userIds = rows.map((r) => r.userId).sort((a, b) => a - b);
  const expected = INCLUDED.map((name) => CASES[name].userId).sort((a, b) => a - b);

  // Reported per case, because "expected [a,b] got [c]" on eleven rows is not
  // something anyone wants to debug.
  assert.deepEqual(
    userIds,
    expected,
    `included should be ${INCLUDED.join(', ')}; ` +
      `${EXCLUDED.map((n) => `${n} must not appear`).join(', ')}`,
  );

  for (const name of EXCLUDED) {
    assert.ok(
      !userIds.includes(CASES[name].userId),
      `${name} leaked through the candidate query (userId ${CASES[name].userId})`,
    );
  }

  // The `select` shape is part of the contract: the caller reads these four
  // fields to decide whether to ask the scoring engine anything.
  for (const r of rows) {
    assert.deepEqual(
      Object.keys(r).sort(),
      ['pausedFrom', 'pausedUntil', 'scoreTargetFrom', 'userId'],
      'findTargetGoalRowsService must not leak the whole row',
    );
  }
});

test('the window boundary is inclusive on the day it ends, and closed the day after', { skip: SKIP }, async () => {
  await prisma.healthGoal.deleteMany({ where: { userId: { gte: BASE } } });

  // Three otherwise-identical goals whose windows end yesterday, today and
  // tomorrow. Today is the one that decides whether a nudge goes out on the
  // last day of a target, so it is the one with an off-by-one risk.
  const endings = [
    row(40, { scoreTargetUntil: day(-1) }),
    row(41, { scoreTargetUntil: day(0) }),
    row(42, { scoreTargetUntil: day(1) }),
  ];
  await prisma.healthGoal.createMany({ data: endings });

  const userIds = (await nudge.findTargetGoalRowsService(NOW)).map((r) => r.userId);

  assert.ok(userIds.includes(endings[1].userId), 'a window ending today is still open today');
  assert.ok(userIds.includes(endings[2].userId), 'a window ending tomorrow is open');
  assert.ok(!userIds.includes(endings[0].userId), 'a window that ended yesterday is closed');
});

test('the IST day is what decides the window, not the UTC day', { skip: SKIP }, async () => {
  await prisma.healthGoal.deleteMany({ where: { userId: { gte: BASE } } });

  // 19:00 UTC on the 10th is 00:30 IST on the 11th. The IST calendar has
  // ALREADY moved to the 11th at that instant, even though the UTC date
  // still says the 10th — so a window ending on the 10th is CLOSED (its
  // end date has passed, exactly like a window ending yesterday closes at
  // midnight), while a window ending on the 11th has opened. Asserting the
  // 10th window "still open" would be asserting the UTC-day behaviour the
  // title says must NOT happen.
  const lateUtc = new Date('2026-09-10T19:00:00Z');
  await prisma.healthGoal.createMany({
    data: [
      { ...CASES.live, scoreTargetUntil: '2026-09-10' },
      { ...row(20), scoreTargetUntil: '2026-09-11' },
      { ...row(21), scoreTargetUntil: '2026-09-09' },
    ],
  });

  const rows = await nudge.findTargetGoalRowsService(lateUtc);
  const userIds = rows.map((r) => r.userId);

  assert.ok(!userIds.includes(CASES.live.userId), 'the 10th window is closed at 00:30 IST on the 11th');
  assert.ok(userIds.includes(BASE + 20), 'the 11th window has opened at 00:30 IST');
  assert.ok(!userIds.includes(BASE + 21), 'the 9th window closed days ago');
});

test('every type the service offers is a value Postgres will actually store', { skip: SKIP }, async () => {
  // The failure this catches is a 500 on the settings screen: the service
  // validates against NUDGE_TYPES, Prisma generates an enum client from the
  // schema, and Postgres has its own copy of the type. They can drift, and only
  // this test compares all three.
  for (const type of nudge.NUDGE_TYPES) {
    await nudge.setOptOutService(BASE + 30, type, true);
  }

  const stored = await nudge.getOptOutsService(BASE + 30);
  assert.deepEqual(stored.sort(), [...nudge.NUDGE_TYPES].sort());

  // And the round trip the user actually performs.
  await nudge.setOptOutService(BASE + 30, 'target', false);
  assert.ok(!(await nudge.getOptOutsService(BASE + 30)).includes('target'));
});

test('a type Postgres does not have is refused, not silently dropped', { skip: SKIP }, async () => {
  await assert.rejects(
    () => nudge.setOptOutService(BASE + 31, 'marketing', true),
    /type must be one of/,
  );

  // Proving the refusal came from the service's own validation and not from a
  // database error: Postgres would have complained about an unknown enum label.
  const rows = await prisma.nudgeOptOut.findMany({ where: { userId: BASE + 31 } });
  assert.deepEqual(rows, []);
});