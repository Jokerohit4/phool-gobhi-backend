// The coach-journey prescription read (B7): the same three endpoints, plus a
// `journey` context the controller supplies only when the coachJourney flag
// is on.
//
// The two halves of the flag gate are pinned here:
//
//   - WITHOUT the context, everything behaves exactly as before the journey:
//     no target is still a 422, and none of the new fields (workoutSlots,
//     foodSetupNeeded, diet, bodyDataNeeded) appear anywhere in the response.
//     The pre-existing prescriptionService.test.js suite is the rest of that
//     assertion - it passes unmodified.
//   - WITH the context, a user with NO NutritionTarget gets a real plan:
//     kcal null, macros null, the journey's default water, the stored
//     workout slots, and the two flags that tell the app what to ask for
//     next (food consent and setup; height and weight).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPlan, previewPlan, savePlan } from '../services/ledger/prescriptionService.js';

const TARGET = {
  userId: 7,
  goals: ['lose_fat'],
  kcal: 2200,
  proteinG: 130,
  carbsG: 240,
  fatG: 70,
  fibreG: 30,
  waterMl: 3000,
  micros: { ironMg: 18 },
  inputs: {
    weightKg: 72,
    heightCm: 175,
    age: 28,
    sex: 'male',
    activity: 'moderate',
    bmrKcal: 1674,
    maintenanceKcal: 2620,
    fatFraction: 0.28,
  },
  rulesVersion: 'v1',
};

const SLOTS = [
  { weekday: 0, templateId: 11, title: 'Full Body x3 — Beginner-friendly', level: 'beginner' },
  { weekday: 2, templateId: 11, title: 'Full Body x3 — Beginner-friendly', level: 'beginner' },
  { weekday: 4, templateId: 12, title: 'Push Day A', level: 'beginner' },
];

function fakePrisma({
  target = TARGET,
  weekly = { userId: 7, sessionsPerWeek: 3, setByUser: true },
  saved = null,
  goal = null,
  consent = null,
} = {}) {
  const writes = [];
  return {
    writes,
    nutritionTarget: { findFirst: async () => target },
    weeklyGoal: {
      findUnique: async () => weekly,
      upsert: async (args) => writes.push({ model: 'weeklyGoal', args }),
    },
    prescription: {
      findUnique: async () => saved,
      upsert: async (args) => writes.push({ model: 'prescription', args }),
    },
    healthGoal: { findUnique: async () => goal },
    healthConsent: { findUnique: async () => consent },
  };
}

const JOURNEY_L1 = { unlockedLayerKeys: ['workout', 'water'] };
const JOURNEY_L2 = { unlockedLayerKeys: ['workout', 'water', 'food'] };

const NUTRITION_CONSENT = {
  userId: 7,
  scopes: ['nutrition'],
  revokedAt: null,
  scopeVersions: { nutrition: '2026-09-27' },
};

// ---- a plan with no NutritionTarget -----------------------------------------

test('with the journey on, a user with no target gets a plan, not a 422', async () => {
  const prisma = fakePrisma({
    target: null,
    saved: { kcal: null, stepsPerDay: 6000, sleepMinutes: 420, workoutSlots: SLOTS },
    goal: { goals: ['general_health'], diet: 'veg' },
  });

  const plan = await getPlan({ prisma, userId: 7, journey: JOURNEY_L1 });

  assert.equal(prisma.writes.length, 0, 'a read must never write');
  // The honest budget before body data exists: null, never a invented number
  // and never the floor of a slider the person never saw.
  assert.equal(plan.kcal, null);
  assert.equal(plan.proteinG, null);
  assert.equal(plan.carbsG, null);
  assert.equal(plan.fatG, null);
  assert.equal(plan.fibreG, null);
  // The journey's default water (JOURNEY.defaultWaterMl in the Contracts).
  assert.equal(plan.waterMl, 2500);
  assert.deepEqual(plan.micros, {});
  // The starter plan's own numbers still show.
  assert.equal(plan.stepsPerDay, 6000);
  assert.equal(plan.sleepMinutes, 420);
  assert.equal(plan.sessionsPerWeek, 3);
  assert.equal(plan.rulesVersion, 'v1');
});

test('the stored slots are served as both workoutSlots and the legacy workout week', async () => {
  const prisma = fakePrisma({
    saved: { kcal: 2200, stepsPerDay: 8000, sleepMinutes: 420, workoutSlots: SLOTS },
    goal: { goals: ['lose_fat'], diet: null },
  });

  const plan = await getPlan({ prisma, userId: 7, journey: JOURNEY_L1 });

  // One entry per WeeklyGoal.sessionsPerWeek, in the stored order, in the
  // contract's slot shape (weekday 0 = Monday).
  assert.equal(plan.workoutSlots.length, 3);
  assert.deepEqual(
    plan.workoutSlots.map((s) => s.weekday),
    [0, 2, 4],
  );
  assert.equal(plan.workoutSlots[0].templateId, 11);
  assert.equal(plan.workoutSlots[0].level, 'beginner');

  // The legacy `workout` mirrors the slots (1 = Monday), so any screen
  // reading either field sees the same week.
  assert.deepEqual(
    plan.workout.map((w) => w.weekday),
    [1, 3, 5],
  );
  assert.equal(plan.workout[0].title, SLOTS[0].title);
});

test('a pre-journey row (slots null) keeps the computed menu and empty slots', async () => {
  const prisma = fakePrisma({
    saved: { kcal: 2200, stepsPerDay: 8000, sleepMinutes: 420, workoutSlots: null },
    goal: { goals: ['lose_fat'], diet: null },
  });

  const plan = await getPlan({ prisma, userId: 7, journey: JOURNEY_L1 });

  // Empty slots, so the app falls back to the computed menu - exactly what
  // A3's model documents for pre-journey users.
  assert.deepEqual(plan.workoutSlots, []);
  // The menu computation, unchanged: three sessions spread Mon/Wed/Thu per
  // the legacy pattern.
  assert.equal(plan.workout.length, 3);
  assert.deepEqual(
    plan.workout.map((w) => w.weekday),
    [1, 3, 4],
  );
});

// ---- foodSetupNeeded, bodyDataNeeded, diet -----------------------------------

test('foodSetupNeeded is true when food is unlocked but consent or target is missing', async () => {
  const base = {
    saved: { kcal: null, stepsPerDay: 6000, sleepMinutes: 420, workoutSlots: SLOTS },
    goal: { goals: ['general_health'], diet: 'egg' },
  };

  // Food unlocked, no target, no consent: setup needed, body data needed.
  const neither = await getPlan({
    prisma: fakePrisma({ ...base, target: null, consent: null }),
    userId: 7,
    journey: JOURNEY_L2,
  });
  assert.equal(neither.foodSetupNeeded, true);
  assert.equal(neither.bodyDataNeeded, true);
  assert.equal(neither.diet, 'egg');

  // Food unlocked, target exists, consent granted: the plan is fully set up.
  const both = await getPlan({
    prisma: fakePrisma({ ...base, consent: NUTRITION_CONSENT }),
    userId: 7,
    journey: JOURNEY_L2,
  });
  assert.equal(both.foodSetupNeeded, false);
  assert.equal(both.bodyDataNeeded, false);

  // Food unlocked, target exists, but consent never granted: still the setup
  // card, though body data is no longer what is missing.
  const noConsent = await getPlan({
    prisma: fakePrisma({ ...base, consent: null }),
    userId: 7,
    journey: JOURNEY_L2,
  });
  assert.equal(noConsent.foodSetupNeeded, true);
  assert.equal(noConsent.bodyDataNeeded, false);

  // A revoked grant is no grant.
  const revoked = await getPlan({
    prisma: fakePrisma({ ...base, consent: { ...NUTRITION_CONSENT, revokedAt: new Date() } }),
    userId: 7,
    journey: JOURNEY_L2,
  });
  assert.equal(revoked.foodSetupNeeded, true);

  // A grant under superseded wording is no grant either - same rule the
  // nutrition gate itself enforces.
  const stale = await getPlan({
    prisma: fakePrisma({ ...base, consent: { ...NUTRITION_CONSENT, scopeVersions: { nutrition: '2020-01-01' } } }),
    userId: 7,
    journey: JOURNEY_L2,
  });
  assert.equal(stale.foodSetupNeeded, true);
});

test('food locked means no setup prompt, whatever consent and targets say', async () => {
  const prisma = fakePrisma({
    target: null,
    consent: null,
    saved: { kcal: null, stepsPerDay: 6000, sleepMinutes: 420, workoutSlots: SLOTS },
    goal: { goals: ['general_health'], diet: null },
  });

  // Layer 1 only: no food card, because the layer the card belongs to is
  // closed. Body data is still wanted - the plan asks for it ahead of the
  // food layer unlocking.
  const plan = await getPlan({ prisma, userId: 7, journey: JOURNEY_L1 });
  assert.equal(plan.foodSetupNeeded, false);
  assert.equal(plan.bodyDataNeeded, true);
  assert.equal(plan.diet, null);
});

// ---- preview and save on the journey path ----------------------------------

test('a journey preview with no target neither writes nor throws', async () => {
  const prisma = fakePrisma({
    target: null,
    saved: { kcal: null, stepsPerDay: 6000, sleepMinutes: 420, workoutSlots: SLOTS },
    goal: { goals: [], diet: null },
  });

  const plan = await previewPlan({
    prisma,
    userId: 7,
    draft: { stepsPerDay: 8000, sleepMinutes: 450 },
    journey: JOURNEY_L1,
  });

  assert.equal(prisma.writes.length, 0, 'a preview must never write');
  assert.equal(plan.kcal, null);
  assert.equal(plan.stepsPerDay, 8000);
  assert.equal(plan.sleepMinutes, 450);
});

test('a journey save keeps kcal null when no target exists', async () => {
  const prisma = fakePrisma({
    target: null,
    saved: { kcal: null, stepsPerDay: 6000, sleepMinutes: 420, workoutSlots: SLOTS },
    goal: { goals: [], diet: 'veg' },
  });

  const plan = await savePlan({
    prisma,
    userId: 7,
    draft: { stepsPerDay: 7000, sleepMinutes: 420 },
    journey: JOURNEY_L1,
  });

  const [saved] = prisma.writes.filter((w) => w.model === 'prescription');
  assert.equal(saved.args.update.kcal, null);
  assert.equal(saved.args.update.stepsPerDay, 7000);
  assert.equal(plan.kcal, null);
  assert.equal(plan.foodSetupNeeded, false, 'food is locked at layer 1');
  assert.equal(plan.diet, 'veg');
});

// ---- the flag-off path is byte-for-byte --------------------------------------

test('without the journey context nothing changes: the refusal stands and no new fields appear', async () => {
  const prisma = fakePrisma({
    target: null,
    saved: { kcal: null, stepsPerDay: 6000, sleepMinutes: 420, workoutSlots: SLOTS },
    goal: { goals: [], diet: 'veg' },
    consent: NUTRITION_CONSENT,
  });

  await assert.rejects(
    () => getPlan({ prisma, userId: 7 }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'PRESCRIPTION_UNAVAILABLE');
      return true;
    },
  );

  // And with a target, the response carries none of the journey's fields -
  // a client on the old build must see the old shape, key for key.
  const plan = await getPlan({
    prisma: fakePrisma({
      saved: { kcal: 2200, stepsPerDay: 8000, sleepMinutes: 420, workoutSlots: SLOTS },
      goal: { goals: ['lose_fat'], diet: 'veg' },
      consent: NUTRITION_CONSENT,
    }),
    userId: 7,
  });
  for (const field of ['workoutSlots', 'foodSetupNeeded', 'bodyDataNeeded', 'diet']) {
    assert.equal(field in plan, false, `${field} leaked into a flag-off response`);
  }
  assert.equal(plan.kcal, 2200);
  // The menu computation, not the stored slots.
  assert.equal(plan.workout.length, 3);
  assert.ok(plan.workout.every((w) => w.focus && w.intensity), 'the legacy menu carries focus and intensity');
});
