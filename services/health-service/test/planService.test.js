// H-22 (docs/../sprint2/PG-HUNT-001). The day/week position is DERIVED
// from startedOn + today, never stored as a separate pointer — four
// properties matter and none is obvious from reading the code:
//
//   1. Day 1 is the day the plan was started, not the day after.
//   2. The day number is clamped to the plan's total length, so a user who
//      redeemed the plan a month ago and never opened the app again sees
//      the last day, not an out-of-range week/day pair.
//   3. Restarting a plan (including the SAME one) resets startedOn to
//      today — "start over" must mean start over, not no-op.
//   4. Day-vs-week math (week = ceil(day/7), day-of-week = ((day-1)%7)+1)
//      matches a real calendar exactly at every 7-day boundary, not off by
//      one at the seams.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let plans = [];
let planDays = [];
let activePlans = new Map(); // userId -> row
let nextId = 1;

function reset() {
  plans = [];
  planDays = [];
  activePlans = new Map();
  nextId = 1;
}

function seedPlan({ key = 'home_starter_4w', weeks = 4, isSystem = true } = {}) {
  const plan = { id: nextId++, key, name: 'Home Starter', description: null, weeks, isSystem };
  plans.push(plan);
  return plan;
}

function seedDay(planId, weekIndex, dayIndex, templateId = null) {
  planDays.push({ id: nextId++, planId, weekIndex, dayIndex, templateId, template: templateId ? { id: templateId, name: `T${templateId}`, exercises: [] } : null });
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

let listPlansService, getActivePlanService, startPlanService, abandonPlanService;

test('setup: mock prisma once, import planService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutPlan = {
            findMany: async ({ where }) => plans.filter((p) => (where?.isSystem === undefined ? true : p.isSystem === where.isSystem)),
            findUnique: async ({ where }) => plans.find((p) => p.key === where.key || p.id === where.id) ?? null,
          };
          this.workoutPlanDay = {
            findUnique: async ({ where }) => {
              const k = where.planId_weekIndex_dayIndex;
              return planDays.find((d) => d.planId === k.planId && d.weekIndex === k.weekIndex && d.dayIndex === k.dayIndex) ?? null;
            },
          };
          this.userActivePlan = {
            findUnique: async ({ where }) => {
              const row = activePlans.get(where.userId);
              if (!row) return null;
              return { ...row, plan: plans.find((p) => p.id === row.planId) };
            },
            upsert: async ({ where, create, update }) => {
              const existing = activePlans.get(where.userId);
              const row = existing ? { ...existing, ...update } : { userId: where.userId, ...create };
              activePlans.set(where.userId, row);
              return row;
            },
            deleteMany: async ({ where }) => {
              activePlans.delete(where.userId);
              return { count: 1 };
            },
            update: async ({ where, data }) => {
              const row = { ...activePlans.get(where.userId), ...data };
              activePlans.set(where.userId, row);
              return row;
            },
          };
        }
      },
    },
  });

  ({ listPlansService, getActivePlanService, startPlanService, abandonPlanService } = await import('../services/planService.js'));
});

test('listPlansService returns only system plans, ordered by id', async () => {
  reset();
  seedPlan({ key: 'a' });
  seedPlan({ key: 'b' });
  const plans = await listPlansService();
  assert.deepEqual(plans.map((p) => p.key), ['a', 'b']);
});

test('a user with no active plan gets null, not an error', async () => {
  reset();
  const active = await getActivePlanService(1);
  assert.equal(active, null);
});

test('day 1 is the day the plan was started, not the day after', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 });
  seedDay(plan.id, 1, 1, 101);
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(0), completedAt: null });

  const active = await getActivePlanService(1);
  assert.equal(active.dayNumber, 1);
  assert.equal(active.weekIndex, 1);
  assert.equal(active.dayIndex, 1);
  assert.equal(active.todayTemplate.id, 101);
});

test('day 8 is the first day of week 2', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 });
  seedDay(plan.id, 2, 1, 201);
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(7), completedAt: null });

  const active = await getActivePlanService(1);
  assert.equal(active.dayNumber, 8);
  assert.equal(active.weekIndex, 2);
  assert.equal(active.dayIndex, 1);
});

test('day 7 is the LAST day of week 1, not the first day of week 2 (no off-by-one at the boundary)', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 });
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(6), completedAt: null });

  const active = await getActivePlanService(1);
  assert.equal(active.dayNumber, 7);
  assert.equal(active.weekIndex, 1);
  assert.equal(active.dayIndex, 7);
});

test('a plan abandoned long ago clamps at the last day instead of running past the end', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 }); // 28 days total
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(100), completedAt: null });

  const active = await getActivePlanService(1);
  assert.equal(active.dayNumber, 28);
  assert.equal(active.weekIndex, 4);
  assert.equal(active.dayIndex, 7);
  assert.equal(active.isLastDay, true);
});

// Bug fixed 2026-09-11: completedAt was defined on the model and exposed in
// the DPDPA export, but nothing anywhere ever wrote it — a plan could run
// its full 28 days and STILL read back completedAt: null forever.
test('a plan that has genuinely run its full course gets completedAt set', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 }); // 28 days
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(100), completedAt: null });

  const active = await getActivePlanService(1);
  assert.equal(active.isFinished, true);
  assert.ok(active.completedAt, 'completedAt must be set once the plan is finished');
});

test('exactly on the last day, the plan is NOT yet finished — only past it', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 }); // 28 days
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(27), completedAt: null }); // day 28 exactly

  const active = await getActivePlanService(1);
  assert.equal(active.dayNumber, 28);
  assert.equal(active.isLastDay, true);
  assert.equal(active.isFinished, false);
  assert.equal(active.completedAt, null);
});

test('completedAt is set exactly once and never overwritten on a later read', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 });
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(100), completedAt: null });

  const first = await getActivePlanService(1);
  const second = await getActivePlanService(1);
  assert.equal(first.completedAt.getTime(), second.completedAt.getTime());
});

test('a scheduled rest day (no template) is a valid day, not a seeding gap', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 });
  seedDay(plan.id, 1, 3, null); // explicit rest day, day 3
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(2), completedAt: null });

  const active = await getActivePlanService(1);
  assert.equal(active.dayNumber, 3);
  assert.equal(active.todayTemplate, null);
});

test('starting a plan the user is already on resets startedOn to today', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 });
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(20), completedAt: null });

  const active = await startPlanService(1, plan.key);
  assert.equal(active.dayNumber, 1); // back to day 1, not day 21
});

test('starting an unknown plan key is a 404', async () => {
  reset();
  await assert.rejects(
    () => startPlanService(1, 'does_not_exist'),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('abandonPlanService clears the active plan cleanly', async () => {
  reset();
  const plan = seedPlan({ weeks: 4 });
  activePlans.set(1, { userId: 1, planId: plan.id, startedOn: daysAgo(0), completedAt: null });

  await abandonPlanService(1);
  const active = await getActivePlanService(1);
  assert.equal(active, null);
});
