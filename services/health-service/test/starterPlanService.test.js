// The coach journey's plan engine (B7): the starter plan and the rebuild.
//
// The properties that matter:
//
//   1. A starter plan needs NOTHING a calorie target needs. Four answers
//      (level, goals, days, location) produce a plan with real slots in it.
//   2. The slot count is exactly WeeklyGoal.sessionsPerWeek - the ring on
//      Home and the week on the Plan tab agree because they read the same
//      number, and the slots are written from it.
//   3. createStarterPlan hands the row work to rebuildPlan({reason:'start'}),
//      and regenerateForUser is a one-line wrapper over
//      rebuildPlan({reason:'unlock'}) - there is exactly ONE rebuild
//      implementation (one-plan UB1).
//   4. resolveUnlockedLayerKeys returns the journey service's answer, or the
//      honest layer-1 fallback when there is none.
//
// rebuildPlan is mocked here: its own behaviour is pinned by
// rebuildPlan.test.js, so this file is about the seam (which reason is asked
// for, and what is written before the ask).
//
// Run with: node --experimental-test-module-mocks --test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---- the rebuildPlan seam ----------------------------------------------------

const rebuildCalls = [];
const state = {
  rebuildResult: { created: 2, updated: 0, deactivated: 0, onLayerKeys: ['workout', 'water'] },
  unlockedKeys: ['workout', 'water', 'food'],
  unlockedThrows: false,
};

mock.module('../services/plan/rebuildPlan.js', {
  exports: {
    rebuildPlan: async (prisma, userId, options) => {
      rebuildCalls.push({ prisma, userId, options });
      return state.rebuildResult;
    },
  },
});

// The journey reads are imported lazily by resolveUnlockedLayerKeys.
mock.module('../services/journey/journeyService.js', {
  exports: {
    getUnlockedLayerKeys: async () => {
      if (state.unlockedThrows) throw new Error('journey service unavailable');
      return state.unlockedKeys;
    },
  },
});

const {
  buildWorkoutSlots,
  createStarterPlan,
  refreshWorkoutSlotsForProfile,
  regenerateForUser,
  resolveUnlockedLayerKeys,
  START_LAYER,
} = await import('../services/ledger/starterPlanService.js');

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
    healthConsent: { findUnique: async () => null },
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

test('createStarterPlan writes the goal, the session count and the prescription defaults, then rebuilds', async () => {
  rebuildCalls.length = 0;
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
  assert.equal(saved.args.create.workoutSlots.length, 3);

  // The rows are not written here: the one rebuild implementation is asked for
  // them, with the start reason.
  assert.equal(rebuildCalls.length, 1);
  assert.equal(rebuildCalls[0].userId, 7);
  assert.equal(rebuildCalls[0].options.reason, 'start');
});

test('a target that already exists sets the starter budget, and goals survive a re-run', async () => {
  rebuildCalls.length = 0;
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

test('a first plan anchors the week on the start day so day one is a workout day', async () => {
  // Saturday (5) is outside the Mon/Wed/Thu spread: unanchored, day one is rest.
  const slots = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'new_to_gym',
    location: 'gym',
    sessions: 3,
    startWeekday: 5,
  });
  assert.equal(slots[0].weekday, 5);
  assert.deepEqual(slots.map((s) => s.weekday), [5, 0, 1]);
});

test('a rebuild keeps the weekdays the plan already has instead of re-laying the week', async () => {
  // The first plan was anchored on a Saturday: Sat/Mon/Tue. Without keeping
  // them, a rebuild falls back to Mon/Wed/Thu and today becomes a rest day.
  const kept = [5, 0, 1];
  const same = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'new_to_gym', location: 'gym', sessions: 3, keepWeekdays: kept,
  });
  assert.deepEqual(same.map((s) => s.weekday), [5, 0, 1]);

  // Fewer sessions drop days from the end; the first days stay.
  const fewer = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'new_to_gym', location: 'gym', sessions: 2, keepWeekdays: kept,
  });
  assert.deepEqual(fewer.map((s) => s.weekday), [5, 0]);

  // More sessions keep every existing day and add from the usual spread, never
  // doubling a weekday.
  const more = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'new_to_gym', location: 'gym', sessions: 4, keepWeekdays: kept,
  });
  assert.deepEqual(more.map((s) => s.weekday), [5, 0, 1, 2]);
  assert.equal(new Set(more.map((s) => s.weekday)).size, 4);

  // Nothing to keep behaves as before.
  const none = await buildWorkoutSlots(fakePrisma(), {
    experienceLevel: 'new_to_gym', location: 'gym', sessions: 3, keepWeekdays: [],
  });
  assert.deepEqual(none.map((s) => s.weekday), [0, 2, 3]);
});

test('a named rest day still wins over a kept weekday', async () => {
  // preferredRestDay uses Sunday=0, so 6 is Saturday (5 in slot terms).
  const prisma = fakePrisma({
    prisma: { personalisationProfile: { findUnique: async () => ({ preferredRestDay: 6 }) } },
  });
  const slots = await buildWorkoutSlots(prisma, {
    experienceLevel: 'new_to_gym', location: 'gym', sessions: 3, userId: 7, keepWeekdays: [5, 0, 1],
  });
  assert.ok(!slots.some((s) => s.weekday === 5), 'a slot landed on the named rest day');
  assert.deepEqual(slots.map((s) => s.weekday), [0, 1, 2]);
});

test('refreshing slots for a profile change keeps the planned weekdays and rebuilds the plan', async () => {
  rebuildCalls.length = 0;
  const written = [];
  const prisma = fakePrisma({
    state: {
      prescription: {
        workoutSlots: [5, 0, 1].map((weekday) => ({
          weekday, location: 'gym', title: 'Full Body x3 — Beginner-friendly',
        })),
      },
    },
  });
  prisma.prescription.update = async ({ data }) => { written.push(data); };

  const ok = await refreshWorkoutSlotsForProfile(prisma, 7);

  assert.equal(ok, true);
  assert.deepEqual(written[0].workoutSlots.map((s) => s.weekday), [5, 0, 1]);
  assert.equal(rebuildCalls.at(-1).options.reason, 'personalisation');
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

// ---- regenerateForUser: a one-line wrapper over the one rebuild ----------------

test('regenerateForUser asks rebuildPlan for an unlock rebuild and returns its result', async () => {
  rebuildCalls.length = 0;
  const prisma = fakePrisma();
  state.rebuildResult = { created: 3, updated: 1, deactivated: 2, onLayerKeys: ['workout', 'water', 'food'] };

  const out = await regenerateForUser(prisma, 7);

  assert.equal(rebuildCalls.length, 1);
  assert.equal(rebuildCalls[0].prisma, prisma);
  assert.equal(rebuildCalls[0].userId, 7);
  assert.equal(rebuildCalls[0].options.reason, 'unlock');
  // The result is passed through untouched.
  assert.deepEqual(out, { created: 3, updated: 1, deactivated: 2, onLayerKeys: ['workout', 'water', 'food'] });
});

test('legacy options are accepted and ignored - there is no second rebuild path', async () => {
  rebuildCalls.length = 0;
  const prisma = fakePrisma();

  await regenerateForUser(prisma, 7, { unlockedLayerKeys: ['workout', 'water'], easeBack: true });

  assert.equal(rebuildCalls.length, 1);
  // onLayerKeys come from layerState on every rebuild, and slot reshaping is
  // UB4's saveSlots - neither leaks in from the caller here.
  assert.deepEqual(rebuildCalls[0].options, { reason: 'unlock' });
});

// ---- resolveUnlockedLayerKeys --------------------------------------------------

test('resolveUnlockedLayerKeys returns the journey service answer when there is one', async () => {
  state.unlockedThrows = false;
  state.unlockedKeys = ['workout', 'water', 'food'];
  assert.deepEqual(await resolveUnlockedLayerKeys(7), ['workout', 'water', 'food']);
});

test('resolveUnlockedLayerKeys falls back to layer 1 when the journey service throws', async () => {
  state.unlockedThrows = true;
  assert.deepEqual(await resolveUnlockedLayerKeys(7), ['workout', 'water']);
});

test('resolveUnlockedLayerKeys falls back when the journey service answers with nothing', async () => {
  state.unlockedThrows = false;
  state.unlockedKeys = [];
  assert.deepEqual(await resolveUnlockedLayerKeys(7), ['workout', 'water']);
});

// ---- the starting layers -------------------------------------------------------

test('the starting layers match the Contracts', () => {
  assert.deepEqual(START_LAYER, {
    new_to_gym: 1,
    just_started: 1,
    restarting_after_break: 2,
    experienced: 5,
  });
});
