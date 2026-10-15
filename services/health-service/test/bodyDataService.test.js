// Body data and diet for the coach journey (B7): the two answers a plan
// needs before its food half can exist.
//
// What is pinned here:
//   - a save of height and weight alone is never an error, writes exactly the
//     two rows it was given, and still rebuilds + returns the plan (the
//     journey asks over several screens; a partial answer must not 400);
//   - with sex and date of birth present, the target computation runs through
//     targetService's OWN function (never a second formula) and the plan is
//     rebuilt afterwards - that rebuild is what turns a new NutritionTarget
//     into food items on the Plan tab;
//   - the conservative 'light' activity guess is written only when the user
//     has no activity answer of their own;
//   - saveDiet writes HealthGoal.diet and nothing else, and rejects a diet
//     the contract does not name.
//
// targetService.recomputeTargets is mocked (its full computation needs the
// biometric/activity history and is targetService.test.js's own subject);
// everything between the controller and the plan - the writes, the guards,
// the rebuild, the returned plan shape - runs for real against the fake
// prisma. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const recomputeCalls = [];
let recomputeResult = { written: true };

test('setup: mock targetService once, import bodyDataService once', async (t) => {
  t.mock.module(new URL('../services/ledger/targetService.js', import.meta.url).href, {
    exports: {
      recomputeTargets: async (args) => {
        recomputeCalls.push(args);
        return recomputeResult;
      },
    },
  });

  // UB1: regenerateForUser now delegates to rebuildPlan, whose layerState
  // dependency (getOnLayerKeys) is still a 501 stub until UB2 merges. Mock the
  // rebuild so this suite keeps testing what it is about - the writes this
  // service makes and the plan it returns - not the plan engine. The plan
  // engine has its own coverage in test/rebuildPlan.test.js.
  t.mock.module(new URL('../services/plan/rebuildPlan.js', import.meta.url).href, {
    exports: {
      rebuildPlan: async () => ({ created: 0, updated: 0, deactivated: 0, onLayerKeys: [] }),
    },
  });

  ({ ageOn } = await import('../services/ledger/bodyDataService.js'));
  ({ save, saveDiet } = await import('../services/ledger/bodyDataService.js'));
  assert.equal(typeof save, 'function');
  assert.equal(typeof saveDiet, 'function');
});

let ageOn, save, saveDiet;

function resetFakes() {
  recomputeCalls.length = 0;
  recomputeResult = { written: true };
}

// The same fake prisma family starterPlanService.test.js uses - the rebuild
// and the plan read run for real against it.
function fakePrisma(overrides = {}) {
  const writes = [];
  const state = {
    healthGoal: null,
    weeklyGoal: null,
    prescription: null,
    journeyProgress: null,
    nutritionTarget: null,
    activity: null,
    ...overrides.state,
  };
  const prisma = {
    writes,
    state,
    healthGoal: {
      findUnique: async () => state.healthGoal,
      upsert: async ({ create, update }) => {
        writes.push({ model: 'healthGoal', create, update });
        state.healthGoal = state.healthGoal ? { ...state.healthGoal, ...update } : { ...create };
        return state.healthGoal;
      },
    },
    weeklyGoal: {
      findUnique: async () => state.weeklyGoal,
      upsert: async ({ create, update }) => {
        writes.push({ model: 'weeklyGoal', create, update });
        state.weeklyGoal = state.weeklyGoal ? { ...state.weeklyGoal, ...update } : { ...create };
        return state.weeklyGoal;
      },
    },
    prescription: {
      findUnique: async () => state.prescription,
      upsert: async ({ create, update }) => {
        writes.push({ model: 'prescription', create, update });
        state.prescription = state.prescription ? { ...state.prescription, ...update } : { ...create };
        return state.prescription;
      },
    },
    journeyProgress: { findUnique: async () => state.journeyProgress },
    nutritionTarget: { findFirst: async () => state.nutritionTarget },
    healthConsent: { findUnique: async () => null },
    workoutTemplate: { findMany: async () => [] },
    planItem: {
      count: async () => 0,
      updateMany: async (args) => {
        writes.push({ model: 'planItem.updateMany', args });
        return { count: 0 };
      },
      create: async (args) => {
        writes.push({ model: 'planItem.create', args });
        return { id: writes.length, ...args.data };
      },
    },
    personalisationProfile: {
      upsert: async (args) => {
        writes.push({ model: 'personalisationProfile', ...args });
        return { ...args.create, ...args.update };
      },
    },
    biometricEntry: {
      findFirst: async () => null,
      upsert: async (args) => {
        writes.push({ model: 'biometricEntry', ...args });
        return { ...args.create, ...args.update };
      },
    },
    ...overrides.prisma,
  };
  return prisma;
}

// ---- ageOn -------------------------------------------------------------------

test('ageOn counts whole years the way a person does', () => {
  assert.equal(ageOn('1995-06-15', '2026-10-12'), 31, 'birthday already passed this year');
  assert.equal(ageOn('1990-10-20', '2026-10-12'), 35, 'birthday not yet reached this year');
  assert.equal(ageOn('1990-10-12', '2026-10-12'), 36, 'the birthday itself counts');
  assert.equal(ageOn('2000-02-29', '2026-10-12'), 26, 'a leap-day birthday is a normal year the rest of the time');
});

test('ageOn refuses to guess: junk, future and out-of-range answers are null', () => {
  assert.equal(ageOn('not-a-date', '2026-10-12'), null);
  assert.equal(ageOn('1995-06-15', 'junk'), null);
  assert.equal(ageOn(null, '2026-10-12'), null);
  assert.equal(ageOn('2030-01-01', '2026-10-12'), null, 'a future birthday is not an age');
  assert.equal(ageOn('1850-01-01', '2026-10-12'), null, 'nobody is 176');
});

// ---- save --------------------------------------------------------------------

test('height and weight alone are written, and the plan still comes back', async () => {
  resetFakes();
  const prisma = fakePrisma();

  const out = await save(prisma, 7, { heightCm: 175, weightKg: 72.4 });

  assert.equal(out.writes.heightCm, true);
  assert.equal(out.writes.weightKg, true);
  assert.equal(out.writes.sexAndAge, undefined, 'no sex and dob, no target write');
  assert.equal(out.targetWritten, false);

  const profile = prisma.writes.find((w) => w.model === 'personalisationProfile');
  assert.equal(profile.create.heightCm, 175);
  const weighIn = prisma.writes.find((w) => w.model === 'biometricEntry');
  assert.equal(weighIn.create.metric, 'weight');
  assert.equal(weighIn.create.unit, 'kg');
  assert.equal(weighIn.create.value, 72.4, 'the weigh-in keeps its decimals');
  assert.equal(weighIn.create.localDate, TODAY, 'a weigh-in belongs to the day it happened');
  assert.equal(weighIn.where.userId_metric_localDate.metric, 'weight', 're-saving today corrects today');

  assert.equal(recomputeCalls.length, 0, 'no target computation without sex and dob');
  // The plan was still rebuilt and read back - a partial save must not
  // strand the Plan tab.
  assert.ok(out.plan, 'the plan is returned');
  assert.equal(out.plan.kcal, null, 'no target yet, so no invented budget');
});

test('with sex and date of birth the target is computed by targetService and the plan rebuilt', async () => {
  resetFakes();
  const prisma = fakePrisma();

  const out = await save(prisma, 7, { heightCm: 175, weightKg: 72, sex: 'male', dateOfBirth: '1995-06-15' });

  assert.equal(out.writes.sexAndAge, true);
  assert.equal(out.targetWritten, true);
  assert.equal(recomputeCalls.length, 1, 'exactly one recompute');
  assert.equal(recomputeCalls[0].userId, 7);
  assert.equal(recomputeCalls[0].localDate, TODAY);

  const goalWrite = prisma.writes.find((w) => w.model === 'healthGoal');
  assert.equal(goalWrite.create.sex, 'male');
  const expectedAge = ageOn('1995-06-15', TODAY);
  assert.equal(goalWrite.create.age, expectedAge, 'the age cache matches the age the computation will read');
  assert.equal(goalWrite.create.activity, 'light', 'a beginner with no activity answer counts as light');
});

test('a user with their own activity answer keeps it', async () => {
  resetFakes();
  const prisma = fakePrisma({ state: { healthGoal: { userId: 7, activity: 'moderate' } } });

  await save(prisma, 7, { sex: 'female', dateOfBirth: '1992-03-01' });

  const goalWrite = prisma.writes.find((w) => w.model === 'healthGoal');
  assert.equal('activity' in goalWrite.update, false, 'the intake answer is not overwritten by a guess');
  assert.equal(prisma.state.healthGoal.activity, 'moderate');
});

test('a user with no goal row at all gets the light default on create', async () => {
  resetFakes();
  const prisma = fakePrisma();

  await save(prisma, 7, { sex: 'female', dateOfBirth: '1992-03-01' });

  const goalWrite = prisma.writes.find((w) => w.model === 'healthGoal');
  assert.equal(goalWrite.create.activity, 'light');
  assert.equal(goalWrite.create.sex, 'female');
});

test('answers outside human range are refused before anything is written', async () => {
  resetFakes();
  for (const [patch, message] of [
    [{ heightCm: 99 }, /heightCm/],
    [{ heightCm: 251 }, /heightCm/],
    [{ weightKg: 24 }, /weightKg/],
    [{ weightKg: 401 }, /weightKg/],
    [{ sex: 'male', dateOfBirth: '2030-01-01' }, /dateOfBirth/],
    [{ sex: 'male', dateOfBirth: '12/06/1995' }, /dateOfBirth/],
  ]) {
    const prisma = fakePrisma();
    await assert.rejects(() => save(prisma, 7, patch), message, `save accepted ${JSON.stringify(patch)}`);
    assert.equal(prisma.writes.length, 0, 'a refused save must not write');
  }
  assert.equal(recomputeCalls.length, 0);
});

test('a save without a target never invents a calorie budget', async () => {
  resetFakes();
  const prisma = fakePrisma();

  const out = await save(prisma, 7, { heightCm: 170 });

  // UB1: the rebuild now writes planItem rows through rebuildPlan and no longer
  // rewrites the prescription, so the guarantee moves to the returned plan: a
  // user without a target comes back with no budget.
  const saved = prisma.writes.find((w) => w.model === 'prescription');
  assert.equal(saved, undefined, 'the rebuild no longer rewrites the prescription');
  assert.equal(out.plan.kcal, null, 'no target yet, so no invented budget');
});

// ---- saveDiet ----------------------------------------------------------------

test('saveDiet writes the diet answer and returns the plan', async () => {
  resetFakes();
  const prisma = fakePrisma();

  const out = await saveDiet(prisma, 7, 'veg');

  assert.equal(out.diet, 'veg');
  const goalWrite = prisma.writes.find((w) => w.model === 'healthGoal');
  assert.equal(goalWrite.create.diet, 'veg');
  assert.equal(prisma.state.healthGoal.diet, 'veg');
  assert.ok(out.plan, 'the plan is returned');
  // The diet is asked before consent and targets exist; neither may be
  // required for the answer to land.
  assert.equal(out.plan.foodSetupNeeded, false, 'food is still locked at layer 1 - no card yet');
});

test('saveDiet overwrites a previous answer and works with a goal row that already exists', async () => {
  resetFakes();
  const prisma = fakePrisma({ state: { healthGoal: { userId: 7, diet: 'veg' } } });

  const out = await saveDiet(prisma, 7, 'egg');
  assert.equal(out.diet, 'egg');
  assert.equal(prisma.state.healthGoal.diet, 'egg');
});

test('saveDiet rejects a diet the contract does not name', async () => {
  resetFakes();
  const prisma = fakePrisma();
  await assert.rejects(
    () => saveDiet(prisma, 7, 'pescatarian'),
    /diet must be one of: veg, egg, non_veg, vegan, jain/,
  );
  assert.equal(prisma.writes.length, 0, 'a refused diet must not write');
});
