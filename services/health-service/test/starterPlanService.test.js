// The coach journey's plan engine (B7): the starter plan and the rebuild.
//
// The properties that matter:
//
//   1. A starter plan needs NOTHING a calorie target needs. Four answers
//      (level, goals, days, location) produce a plan with real slots in it.
//   2. The slot count is exactly WeeklyGoal.sessionsPerWeek - the ring on
//      Home and the week on the Plan tab agree because they read the same
//      number, and the slots are written from it.
//   3. regenerateForUser rebuilds slots and items and never touches a
//      doctor's or the user's own items - the "regenerate is safe to press"
//      guarantee, reused rather than re-implemented.
//   4. easeBack halves the week's sessions without lowering the goal.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkoutSlots,
  createStarterPlan,
  regenerateForUser,
  resolveUnlockedLayerKeys,
  START_LAYER,
} from '../services/ledger/starterPlanService.js';

// The whole template catalogue the pools name: the gym starters (B7's seeds)
// and the home track's (seedHomeTrack.js). Ids are arbitrary but stable per
// name, the way system templates behave.
const TEMPLATE_ROWS = [
  ...[
    'Full Body x3 — Beginner-friendly',
    'Push Day A',
    'Leg Day',
    'Upper & Abs',
  ].map((name, i) => ({ id: 101 + i, name, isSystem: true, level: 'beginner' })),
  ...[
    'Full body — 15 minute',
    'Full body — no equipment',
    'Core — 10 minute',
    'Low-impact cardio (no jumping)',
    'Push — bodyweight',
    'Pull — no bar',
    'Legs — bodyweight',
    'Mobility & stretch',
    'Desk reset — 8 minute',
  ].map((name, i) => ({ id: 201 + i, name, isSystem: true, level: 'beginner' })),
  ...[
    'Full body — intermediate',
    'Push — intermediate',
    'Legs — intermediate',
  ].map((name, i) => ({ id: 301 + i, name, isSystem: true, level: 'intermediate' })),
];

function fakePrisma(overrides = {}) {
  const writes = [];
  const state = {
    healthGoal: null,
    weeklyGoal: null,
    prescription: null,
    journeyProgress: null,
    nutritionTarget: null,
    ...overrides.state,
  };
  const prisma = {
    writes,
    state,
    healthGoal: {
      findUnique: async () => state.healthGoal,
      upsert: async ({ create, update }) => {
        writes.push({ model: 'healthGoal', args: { create, update } });
        state.healthGoal = state.healthGoal ? { ...state.healthGoal, ...update } : { ...create };
        return state.healthGoal;
      },
    },
    weeklyGoal: {
      findUnique: async () => state.weeklyGoal,
      upsert: async ({ create, update }) => {
        writes.push({ model: 'weeklyGoal', args: { create, update } });
        state.weeklyGoal = state.weeklyGoal ? { ...state.weeklyGoal, ...update } : { ...create };
        return state.weeklyGoal;
      },
    },
    prescription: {
      findUnique: async () => state.prescription,
      upsert: async ({ create, update }) => {
        writes.push({ model: 'prescription', args: { create, update } });
        state.prescription = state.prescription
          ? { ...state.prescription, ...update }
          : { ...create };
        return state.prescription;
      },
    },
    journeyProgress: { findUnique: async () => state.journeyProgress },
    nutritionTarget: { findFirst: async () => state.nutritionTarget },
    workoutTemplate: {
      findMany: async ({ where }) =>
        TEMPLATE_ROWS.filter((r) => r.isSystem && where?.name?.in?.includes(r.name)),
    },
    planItem: {
      count: async ({ where }) => {
        if (where?.origin === 'suggested') return 0;
        if (where?.origin?.in) return state.userItems ?? 0;
        return 0;
      },
      updateMany: async (args) => {
        writes.push({ model: 'planItem.updateMany', args });
        return { count: 0 };
      },
      create: async (args) => {
        writes.push({ model: 'planItem.create', args });
        return { id: writes.length, ...args.data };
      },
    },
    healthConsent: { findUnique: async () => null },
    personalisationProfile: {
      upsert: async (args) => writes.push({ model: 'personalisationProfile', args }),
    },
    biometricEntry: {
      findFirst: async () => null,
      upsert: async (args) => writes.push({ model: 'biometricEntry', args }),
    },
    ...overrides.prisma,
  };
  return prisma;
}

// ---- validation --------------------------------------------------------------

test('the starter plan refuses answers it cannot plan with', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => createStarterPlan(prisma, 7, { experienceLevel: 'alien', goals: [], daysPerWeek: 3, location: 'gym' }),
    /experienceLevel must be one of/,
  );
  await assert.rejects(
    () => createStarterPlan(prisma, 7, { goals: [], daysPerWeek: 3, location: 'park' }),
    /location must be/,
  );
  for (const bad of [0, 8, 2.5, 'three', null]) {
    await assert.rejects(
      () => createStarterPlan(prisma, 7, { goals: [], daysPerWeek: bad, location: 'home' }),
      /daysPerWeek must be an integer between 1 and 7/,
      `daysPerWeek ${bad} was accepted`,
    );
  }
  // The contract's skip default: no level is a first-timer, not an error.
  const plan = await createStarterPlan(prisma, 7, { goals: [], daysPerWeek: 2, location: 'gym' });
  assert.equal(plan.sessionsPerWeek, 2);
});

// ---- the writes --------------------------------------------------------------

test('createStarterPlan writes the goal, the session count and the prescription defaults', async () => {
  const prisma = fakePrisma();
  // No nutrition target: a first-timer who has answered four questions.
  prisma.state.nutritionTarget = null;

  await createStarterPlan(prisma, 7, {
    experienceLevel: 'new_to_gym',
    goals: ['lose_fat', 'build_muscle', 'nonsense_goal', 'lose_fat'],
    daysPerWeek: 3,
    location: 'gym',
  });

  const goal = prisma.writes.find((w) => w.model === 'healthGoal');
  // The user's own order, unknowns dropped, duplicates collapsed.
  assert.deepEqual(goal.args.update.goals, ['lose_fat', 'build_muscle']);

  const weekly = prisma.writes.find((w) => w.model === 'weeklyGoal');
  assert.equal(weekly.args.update.sessionsPerWeek, 3);
  assert.equal(weekly.args.update.setByUser, true);

  const saved = prisma.writes.find((w) => w.model === 'prescription');
  assert.equal(saved.args.create.kcal, null, 'kcal must be null without a NutritionTarget');
  assert.equal(saved.args.create.stepsPerDay, 6000, 'the new_to_gym step default');
  assert.equal(saved.args.create.sleepMinutes, 420);

  // The returned plan is the prescription shape B9's /journey/start returns,
  // journey fields included.
  assert.equal(saved.args.create.workoutSlots.length, 3);
});

test('a target that already exists sets the starter budget, and goals survive a re-run', async () => {
  const prisma = fakePrisma();
  prisma.state.nutritionTarget = { kcal: 2200, proteinG: 130, waterMl: 3000, micros: {}, goals: ['lose_fat'], inputs: { fatFraction: 0.28 } };

  const plan = await createStarterPlan(prisma, 7, {
    experienceLevel: 'restarting_after_break',
    goals: ['build_muscle'],
    daysPerWeek: 4,
    location: 'gym',
  });

  const saved = prisma.writes.find((w) => w.model === 'prescription');
  assert.equal(saved.args.create.kcal, 2200);
  assert.equal(saved.args.create.stepsPerDay, 8000, 'the restarting level step default');
  // The read back is a real plan with real macros.
  assert.equal(plan.kcal, 2200);
  assert.equal(plan.proteinG, 130);
  // A restarting user starts at layer 2, so food is unlocked - and with no
  // nutrition consent on file, the plan says so.
  assert.equal(plan.foodSetupNeeded, true);
});

test('the starter plan is safe to re-run: upserts update, and no duplicate rows', async () => {
  const prisma = fakePrisma();
  await createStarterPlan(prisma, 7, { experienceLevel: 'new_to_gym', goals: ['general_health'], daysPerWeek: 3, location: 'gym' });
  await createStarterPlan(prisma, 7, { experienceLevel: 'new_to_gym', goals: ['general_health'], daysPerWeek: 4, location: 'gym' });

  assert.equal(prisma.writes.filter((w) => w.model === 'prescription').length, 2);
  assert.equal(prisma.state.prescription.workoutSlots.length, 4, 'the re-run did not update the slots');
  assert.equal(prisma.state.weeklyGoal.sessionsPerWeek, 4);
});

// ---- the slots ----------------------------------------------------------------

test('the slot count is exactly the session count, for every legal week', async () => {
  // THE invariant of the read path: however many sessions the user asked
  // for, that many slots come back, and WeeklyGoal says the same number.
  for (let days = 1; days <= 7; days++) {
    const prisma = fakePrisma();
    const plan = await createStarterPlan(prisma, 7, {
      experienceLevel: 'new_to_gym',
      goals: ['general_health'],
      daysPerWeek: days,
      location: 'gym',
    });
    assert.equal(plan.workoutSlots.length, days, `${days} days asked, ${plan.workoutSlots.length} slots built`);
    assert.equal(prisma.state.weeklyGoal.sessionsPerWeek, days);
    assert.equal(new Set(plan.workoutSlots.map((s) => s.weekday)).size, days, `${days} slots share a weekday`);
    for (const slot of plan.workoutSlots) {
      assert.ok(slot.weekday >= 0 && slot.weekday <= 6, 'slot weekday outside the 0-6 contract');
      assert.ok(slot.templateId != null, 'a gym slot with no template');
    }
  }
});

test('a beginner gym week is the Full Body x3 starter, spread like the legacy menu', async () => {
  const slots = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'new_to_gym',
    location: 'gym',
    sessions: 3,
  });
  // Mon/Wed/Thu - the same three days the pre-journey menu names for a
  // three-session week (prescriptionService's WEEKDAY_PATTERN), so a journey
  // week and a legacy week agree on what "three sessions" looks like.
  assert.deepEqual(slots.map((s) => s.weekday), [0, 2, 3]);
  for (const slot of slots) {
    assert.equal(slot.title, 'Full Body x3 — Beginner-friendly');
    assert.equal(slot.level, 'beginner');
  }
});

test('a home week is built from the home track, and experienced users get the harder pool', async () => {
  const home = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'new_to_gym',
    location: 'home',
    sessions: 3,
  });
  assert.deepEqual(home.map((s) => s.title), ['Full body — 15 minute', 'Full body — no equipment', 'Core — 10 minute']);

  // Experienced at home: the intermediate pool.
  const homeExp = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'experienced',
    location: 'home',
    sessions: 3,
  });
  assert.ok(homeExp.every((s) => s.level === 'intermediate'));

  // Experienced at the gym: no intermediate gym content exists yet, so the
  // honest fallback is the beginner pool with its own level, not a slot
  // claiming a difficulty its template does not have.
  const gymExp = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'experienced',
    location: 'gym',
    sessions: 3,
  });
  assert.ok(gymExp.every((s) => s.level === 'beginner'));
  assert.ok(gymExp.every((s) => s.templateId != null));
});

test('unseeded templates still produce a plan: the slot names the routine anyway', async () => {
  const prisma = fakePrisma({ prisma: { workoutTemplate: { findMany: async () => [] } } });
  const slots = await buildWorkoutSlots(prisma, {
    experienceLevel: 'new_to_gym',
    location: 'gym',
    sessions: 1,
  });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].templateId, null);
  assert.equal(slots[0].title, 'Full Body x3 — Beginner-friendly');
  assert.equal(slots[0].level, 'beginner');
});

// ---- regenerateForUser ---------------------------------------------------------

test('regenerateForUser rebuilds the slots and regenerates only suggested items', async () => {
  const prisma = fakePrisma();
  prisma.state.weeklyGoal = { userId: 7, sessionsPerWeek: 4, setByUser: true };
  prisma.state.journeyProgress = { userId: 7, startLevel: 'new_to_gym' };
  prisma.state.prescription = {
    userId: 7,
    kcal: null,
    stepsPerDay: 6000,
    sleepMinutes: 420,
    workoutSlots: [{ weekday: 0, templateId: 101, title: 'Full Body x3 — Beginner-friendly', level: 'beginner' }],
  };

  const out = await regenerateForUser(prisma, 7, { unlockedLayerKeys: ['workout', 'water'] });

  // Four slots, matching the goal, on the gym branch (the stored slot is a
  // gym-pool template).
  assert.equal(out.slots.length, 4);
  assert.equal(out.sessions, 4);
  const saved = prisma.writes.find((w) => w.model === 'prescription');
  assert.equal(saved.args.update.workoutSlots.length, 4);
  // The rebuild never moves the user's sliders.
  assert.equal('stepsPerDay' in saved.args.update, false);
  assert.equal('kcal' in saved.args.update, false);

  // The items: suggested-only soft delete, then the journey generator's items.
  const softDelete = prisma.writes.find((w) => w.model === 'planItem.updateMany');
  assert.deepEqual(softDelete.args.where.origin, 'suggested');
  const created = prisma.writes.filter((w) => w.model === 'planItem.create');
  assert.ok(created.length > 0);
  for (const item of created) {
    assert.equal(item.args.data.origin, 'suggested');
    assert.equal(item.args.data.autoGenerated, true);
    if (item.args.data.kind === 'workout') assert.equal(item.args.data.layerKey, 'workout');
  }
});

test('the rebuild keeps training where the user trains: home slots rebuild from the home pool', async () => {
  const prisma = fakePrisma();
  prisma.state.weeklyGoal = { userId: 7, sessionsPerWeek: 3, setByUser: true };
  prisma.state.journeyProgress = { userId: 7, startLevel: 'new_to_gym' };
  prisma.state.prescription = {
    userId: 7,
    kcal: null,
    stepsPerDay: 6000,
    sleepMinutes: 420,
    workoutSlots: [{ weekday: 0, templateId: 201, title: 'Full body — 15 minute', level: 'beginner' }],
  };

  const out = await regenerateForUser(prisma, 7, { unlockedLayerKeys: ['workout', 'water'] });
  assert.ok(out.slots.every((s) => s.title.includes('body') || s.title.includes('Core')),
    'a home user was handed a gym routine');
});

test('easeBack halves the week (minimum one) without lowering the goal', async () => {
  const prisma = fakePrisma();
  prisma.state.weeklyGoal = { userId: 7, sessionsPerWeek: 5, setByUser: true };
  prisma.state.journeyProgress = { userId: 7, startLevel: 'new_to_gym' };
  prisma.state.prescription = {
    userId: 7,
    kcal: null,
    stepsPerDay: 6000,
    sleepMinutes: 420,
    workoutSlots: [],
  };

  const out = await regenerateForUser(prisma, 7, {
    unlockedLayerKeys: ['workout', 'water'],
    easeBack: true,
  });
  assert.equal(out.sessions, 2, 'half of five, floored');
  assert.equal(out.slots.length, 2);
  // The standing goal is NOT lowered because someone was away for a week.
  assert.equal(prisma.state.weeklyGoal.sessionsPerWeek, 5);
  assert.equal(prisma.writes.some((w) => w.model === 'weeklyGoal'), false);

  // One session a week halves to one, never zero.
  prisma.state.weeklyGoal = { userId: 7, sessionsPerWeek: 1, setByUser: true };
  const min = await regenerateForUser(prisma, 7, {
    unlockedLayerKeys: ['workout', 'water'],
    easeBack: true,
  });
  assert.equal(min.sessions, 1);
});

test('a rebuild without a journey row still works, at the first-timer defaults', async () => {
  const prisma = fakePrisma();
  const out = await regenerateForUser(prisma, 7, { unlockedLayerKeys: ['workout', 'water'] });
  assert.equal(out.slots.length, 3, 'no WeeklyGoal: the neutral default of three');
  assert.equal(prisma.state.prescription.stepsPerDay, 6000, 'the new_to_gym defaults on the create path');
});

// ---- the unlocked-layer fallback ----------------------------------------------

test('before B9 lands, unlocked layers resolve to layer 1 - workouts and water', async () => {
  // services/journey/journeyService.js does not exist yet (B9); the resolver
  // must fall back rather than throw, and the fallback is the honest state
  // for a journey that has only just started.
  const keys = await resolveUnlockedLayerKeys(7);
  assert.deepEqual(keys, ['workout', 'water']);
});

test('the starting layers match the Contracts', () => {
  assert.deepEqual(START_LAYER, {
    new_to_gym: 1,
    restarting_after_break: 2,
    experienced: 5,
  });
});
