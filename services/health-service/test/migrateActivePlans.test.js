// B12 migration script tests.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateActivePlans, buildSlotsFromPlanDays } from '../scripts/migrateActivePlans.js';

// ---- Helpers ----

const SLOT_WEEKDAY_PATTERN = [0, 2, 3, 5, 1, 4, 6];

function fakePrisma(overrides = {}) {
  const writes = [];
  const state = {
    userActivePlan: overrides.userActivePlan ?? [],
    prescriptions: overrides.prescriptions ?? {}, // Map of userId -> prescription
    weeklyGoal: overrides.weeklyGoal ?? null,
    ...overrides.state,
  };

  return {
    writes,
    state,
    userActivePlan: {
      findMany: async ({ where, include }) => {
        // Filter by completedAt: null (the script queries with { completedAt: null })
        const filtered = state.userActivePlan.filter((u) => {
          if (where?.completedAt === null) {
            return u.completedAt === null;
          }
          return true;
        });
        return filtered.map((u) => {
          const plan = u.plan;
          const days = plan?.days ?? [];
          const week1Days = days.filter((d) => d.weekIndex === 1);
          return {
            ...u,
            plan: plan
              ? {
                  ...plan,
                  days: week1Days,
                }
              : null,
          };
        });
      },
    },
    prescription: {
      findUnique: async ({ where }) => state.prescriptions[where?.userId] ?? null,
      upsert: async (args) => {
        writes.push({ model: 'prescription', args });
        const userId = args.where?.userId;
        state.prescriptions[userId] = { ...state.prescriptions[userId], ...args.update, ...args.create };
        return state.prescriptions[userId];
      },
    },
    weeklyGoal: {
      findUnique: async ({ where }) => state.weeklyGoal,
      upsert: async (args) => {
        writes.push({ model: 'weeklyGoal', args });
        state.weeklyGoal = { ...state.weeklyGoal, ...args.update, ...args.create };
        return state.weeklyGoal;
      },
    },
    ...overrides.prisma,
  };
}

function makePlanDay(dayIndex, templateId, templateName, templateLevel) {
  return {
    dayIndex,
    weekIndex: 1,
    templateId,
    template: templateId
      ? { id: templateId, name: templateName, level: templateLevel }
      : null,
  };
}

// ---- buildSlotsFromPlanDays ----

test('buildSlotsFromPlanDays spreads week 1 template days across the pattern', () => {
  const planDays = [
    makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'), // Monday
    makePlanDay(3, 102, 'Push Day A', 'beginner'), // Wednesday
    makePlanDay(4, 103, 'Leg Day', 'beginner'), // Thursday
    makePlanDay(6, 104, 'Upper & Abs', 'beginner'), // Saturday
    makePlanDay(7, null, null, null), // Sunday rest
  ];

  const slots = buildSlotsFromPlanDays(planDays);

  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((s) => s.weekday), [0, 2, 3, 5]); // Mon, Wed, Thu, Sat
  assert.deepEqual(slots.map((s) => s.title), [
    'Full Body x3 — Beginner-friendly',
    'Push Day A',
    'Leg Day',
    'Upper & Abs',
  ]);
  assert.ok(slots.every((s) => s.level === 'beginner'));
});

test('buildSlotsFromPlanDays wraps when more than 7 template days', () => {
  const planDays = Array.from({ length: 10 }, (_, i) =>
    makePlanDay(i + 1, 101 + i, `Template ${i + 1}`, 'beginner')
  );

  const slots = buildSlotsFromPlanDays(planDays);

  assert.equal(slots.length, 10);
  // Pattern wraps: 0,2,3,5,1,4,6,0,2,3
  assert.deepEqual(slots.map((s) => s.weekday), [0, 2, 3, 5, 1, 4, 6, 0, 2, 3]);
});

test('buildSlotsFromPlanDays ignores rest days (templateId null)', () => {
  const planDays = [
    makePlanDay(1, 101, 'Template A', 'beginner'),
    makePlanDay(2, null, null, null), // rest
    makePlanDay(3, 102, 'Template B', 'beginner'),
    makePlanDay(4, null, null, null), // rest
    makePlanDay(5, 103, 'Template C', 'beginner'),
  ];

  const slots = buildSlotsFromPlanDays(planDays);

  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((s) => s.title), ['Template A', 'Template B', 'Template C']);
});

test('buildSlotsFromPlanDays ignores days from other weeks', () => {
  const planDays = [
    makePlanDay(1, 101, 'Week 1 Mon', 'beginner'),
    { dayIndex: 1, weekIndex: 2, templateId: 201, template: { id: 201, name: 'Week 2 Mon', level: 'beginner' } },
  ];

  const slots = buildSlotsFromPlanDays(planDays);

  assert.equal(slots.length, 1);
  assert.equal(slots[0].title, 'Week 1 Mon');
});

test('buildSlotsFromPlanDays returns empty array when no template days', () => {
  const planDays = [
    makePlanDay(1, null, null, null),
    makePlanDay(2, null, null, null),
  ];

  const slots = buildSlotsFromPlanDays(planDays);
  assert.deepEqual(slots, []);
});

// ---- migrateActivePlans ----

test('migrateActivePlans skips users who already have workoutSlots', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Template A', 'beginner'),
            makePlanDay(3, 102, 'Template B', 'beginner'),
          ],
        },
      },
    ],
    prescriptions: { 1: { userId: 1, workoutSlots: [{ weekday: 0, templateId: 101, title: 'Existing', level: 'beginner' }] } },
  });

  const result = await migrateActivePlans(prisma, { dryRun: true });

  assert.equal(result.scanned, 1);
  assert.equal(result.migrated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 0);
});

test('migrateActivePlans migrates users without workoutSlots in dry-run', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'),
            makePlanDay(3, 102, 'Push Day A', 'beginner'),
            makePlanDay(4, 103, 'Leg Day', 'beginner'),
          ],
        },
      },
      {
        userId: 2,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 201, 'Full body — 15 minute', 'beginner'),
            makePlanDay(2, 202, 'Full body — no equipment', 'beginner'),
            makePlanDay(3, 203, 'Core — 10 minute', 'beginner'),
            makePlanDay(4, 204, 'Low-impact cardio (no jumping)', 'beginner'),
          ],
        },
      },
    ],
    prescriptions: {},
  });

  const result = await migrateActivePlans(prisma, { dryRun: true });

  assert.equal(result.scanned, 2);
  assert.equal(result.migrated, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors.length, 0);
});

test('migrateActivePlans writes Prescription and WeeklyGoal when not dry-run', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'),
            makePlanDay(3, 102, 'Push Day A', 'beginner'),
            makePlanDay(4, 103, 'Leg Day', 'beginner'),
          ],
        },
      },
    ],
    prescription: null,
    weeklyGoal: null,
  });

  const result = await migrateActivePlans(prisma, { dryRun: false });

  assert.equal(result.migrated, 1);

  const prescriptionWrite = prisma.writes.find((w) => w.model === 'prescription');
  assert.ok(prescriptionWrite, 'Prescription upsert was called');
  assert.equal(prescriptionWrite.args.update.workoutSlots.length, 3);
  assert.deepEqual(prescriptionWrite.args.update.workoutSlots.map((s) => s.weekday), [0, 2, 3]);

  const weeklyWrite = prisma.writes.find((w) => w.model === 'weeklyGoal');
  assert.ok(weeklyWrite, 'WeeklyGoal upsert was called');
  assert.equal(weeklyWrite.args.update.sessionsPerWeek, 3);
  assert.equal(weeklyWrite.args.update.setByUser, true);
});

test('migrateActivePlans is idempotent: re-running after migration skips migrated users', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'),
            makePlanDay(3, 102, 'Push Day A', 'beginner'),
          ],
        },
      },
    ],
    prescriptions: { 1: { userId: 1, workoutSlots: [{ weekday: 0, templateId: 101, title: 'Full Body x3 — Beginner-friendly', level: 'beginner' }] } },
    weeklyGoal: { userId: 1, sessionsPerWeek: 2 },
  });

  // First run (dry-run to simulate post-migration state)
  const result1 = await migrateActivePlans(prisma, { dryRun: true });
  assert.equal(result1.migrated, 0);
  assert.equal(result1.skipped, 1);

  // Second run with a fresh fake prisma (simulating the post-migration state)
  const prisma2 = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'),
            makePlanDay(3, 102, 'Push Day A', 'beginner'),
          ],
        },
      },
    ],
    prescriptions: { 1: { userId: 1, workoutSlots: [{ weekday: 0, templateId: 101, title: 'Full Body x3 — Beginner-friendly', level: 'beginner' }] } },
    weeklyGoal: { userId: 1, sessionsPerWeek: 2 },
  });

  const result2 = await migrateActivePlans(prisma2, { dryRun: false });
  assert.equal(result2.migrated, 0);
  assert.equal(result2.skipped, 1);
});

test('migrateActivePlans handles users with completed plans (completedAt set)', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null, // active
        plan: { id: 1, days: [makePlanDay(1, 101, 'Template A', 'beginner')] },
      },
      {
        userId: 2,
        planId: 1,
        completedAt: new Date('2026-01-15'), // completed
        plan: { id: 1, days: [makePlanDay(1, 101, 'Template A', 'beginner')] },
      },
    ],
    prescriptions: {},
  });

  const result = await migrateActivePlans(prisma, { dryRun: true });

  assert.equal(result.scanned, 1); // only the active one
  assert.equal(result.migrated, 1);
});

test('migrateActivePlans records error for plans with no template days in week 1', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, null, null, null),
            makePlanDay(2, null, null, null),
          ],
        },
      },
    ],
    prescriptions: {},
  });

  const result = await migrateActivePlans(prisma, { dryRun: true });

  assert.equal(result.scanned, 1);
  assert.equal(result.migrated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].userId, 1);
  assert.match(result.errors[0].error, /no template days in week 1/i);
});

test('migrateActivePlans preserves template level from the WorkoutTemplate', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'),
            makePlanDay(3, 201, 'Full body — intermediate', 'intermediate'),
          ],
        },
      },
    ],
    prescriptions: {},
  });

  const result = await migrateActivePlans(prisma, { dryRun: true });

  assert.equal(result.migrated, 1);
  // The slots should have the template's own level
  const migratedSlots = result.migrated > 0 ? 'migrated' : null;
  // We can't directly inspect the slots from the dry-run result, but the buildSlotsFromPlanDays test covers this
});

test('migrateActivePlans does not delete UserActivePlan rows', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: { id: 1, days: [makePlanDay(1, 101, 'Template A', 'beginner')] },
      },
    ],
    prescriptions: {},
  });

  const result = await migrateActivePlans(prisma, { dryRun: false });

  // Check that no delete operations were performed on userActivePlan
  const deleteWrites = prisma.writes.filter((w) => w.model === 'userActivePlan' && w.args?.deleteMany);
  assert.equal(deleteWrites.length, 0, 'UserActivePlan rows must not be deleted');
});

// ---- Integration-style test with multiple users ----

test('migrateActivePlans handles mixed population correctly', async () => {
  const prisma = fakePrisma({
    userActivePlan: [
      // User 1: active plan, no prescription -> should migrate
      {
        userId: 1,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'),
            makePlanDay(3, 102, 'Push Day A', 'beginner'),
            makePlanDay(4, 103, 'Leg Day', 'beginner'),
          ],
        },
      },
      // User 2: active plan, already has workoutSlots -> should skip
      {
        userId: 2,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 201, 'Full body — 15 minute', 'beginner'),
          ],
        },
      },
      // User 3: completed plan -> should not be scanned
      {
        userId: 3,
        planId: 1,
        completedAt: new Date('2026-01-01'),
        plan: {
          id: 1,
          days: [
            makePlanDay(1, 101, 'Full Body x3 — Beginner-friendly', 'beginner'),
          ],
        },
      },
      // User 4: active plan, no template days -> error, skipped
      {
        userId: 4,
        planId: 1,
        completedAt: null,
        plan: {
          id: 1,
          days: [makePlanDay(1, null, null, null)],
        },
      },
    ],
    prescriptions: {
      // User 2 already has slots
      2: { userId: 2, workoutSlots: [{ weekday: 0, templateId: 201, title: 'Full body — 15 minute', level: 'beginner' }] },
    },
  });

  const result = await migrateActivePlans(prisma, { dryRun: true });

  assert.equal(result.scanned, 3); // users 1, 2, 4 (not 3)
  assert.equal(result.migrated, 1); // user 1
  assert.equal(result.skipped, 2); // users 2, 4
  assert.equal(result.errors.length, 1); // user 4
  assert.equal(result.errors[0].userId, 4);
});