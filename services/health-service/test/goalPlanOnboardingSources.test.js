import assert from 'node:assert/strict';
import test from 'node:test';

let getGoalPlan;
let BIOMETRIC_POLICY_VERSION;
let HEALTH_PROFILE_POLICY_VERSION;
let consent = false;
let weightDeclined = false;
let medicalConsent = false;
let existing = null;
const reads = [];

test('setup goal plan controller with consent and profile sources', async (t) => {
  const read = (name, value) => async ({ where, select }) => {
    assert.equal(where.userId, 42);
    reads.push(name);
    return typeof value === 'function' ? value(select) : value;
  };
  t.mock.module('../db/prisma.js', {
    exports: { default: {
      goalPlan: { findUnique: read('saved', () => existing) },
      coachConsent: { findUnique: read('coachConsent', () => consent ? { scopes: ['basic'] } : null) },
      healthProfileConsent: { findUnique: read('healthConsent', () => consent ? { policyVersion: HEALTH_PROFILE_POLICY_VERSION } : null) },
      biometricConsent: { findUnique: read('bodyConsent', () => consent ? { policyVersion: BIOMETRIC_POLICY_VERSION } : null) },
      ledgerConsent: { findUnique: read('ledgerConsent', () => medicalConsent
        ? { scopes: ['medical_records'], scopeVersions: { medical_records: '2026-09-27' } }
        : null) },
      nutritionTarget: { findFirst: read('nutrition', null) },
      healthProfile: { findUnique: read('healthProfile', (select) => {
        assert.ok(select && !select.allergies && !select.medicationsStatus);
        if (select.allergyStatus) {
          assert.equal(consent, true);
          reads.push('allergy');
          return { allergyStatus: 'has' };
        }
        return Object.fromEntries(Object.entries({
          weightDeclined, occupation: 'desk', dietType: 'vegetarian',
        }).filter(([key]) => select[key]));
      }) },
      healthCondition: { findFirst: read('concern', () => ({ id: 1 })) },
      prescription: { findUnique: read('prescription', null) },
      biometricEntry: { findFirst: read('weight', { value: 86 }) },
      journeyProgress: { findUnique: read('quit', { quitReason: 'alone' }) },
      guidanceProfile: { findUnique: read('report', (select) => {
        assert.deepEqual(select, { confirmedAt: true });
        return { confirmedAt: new Date() };
      }) },
    } },
  });
  t.mock.module('../utils/fetchUserProfile.js', {
    exports: { fetchUserProfileInternal: async (userId, { purpose }) => {
      assert.equal(userId, 42);
      assert.equal(purpose, 'goal_plan');
      reads.push('auth');
      return {
        fitnessGoals: ['weight_loss'], weightLossTargetKg: 5, goalPreferences: ['weight_loss/walking'],
        freeTimeWindow: 'evening', wellnessFocuses: ['sleep'],
      };
    } },
  });
  ({ BIOMETRIC_POLICY_VERSION } = await import('../services/biometricConsentService.js'));
  ({ HEALTH_PROFILE_POLICY_VERSION } = await import('../services/healthProfileConsentService.js'));
  ({ getGoalPlan } = await import('../controllers/coachPlanController.js'));
});

async function readPlan(suggest = '1', onboardingInputs) {
  reads.length = 0;
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await getGoalPlan({ query: { suggest, onboardingInputs }, userId: 42 }, res);
  assert.equal(res.statusCode, undefined, JSON.stringify(res.body));
  return res.body;
}

test('planning preferences work without consent and private answers are not read', async () => {
  consent = false;
  const { personalisation } = await readPlan();
  assert.equal(personalisation.draft.weightLossKg, 5);
  assert.equal(personalisation.draft.targetWeight, null);
  assert.equal(personalisation.draft.steps, 4000);
  assert.equal(personalisation.context.allergyContext, false);
  for (const read of ['weight', 'allergy', 'concern', 'quit', 'prescription', 'nutrition', 'report']) assert.ok(!reads.includes(read), read);
  assert.equal('personalisation' in await readPlan('0'), false);
  assert.deepEqual(reads, ['saved']);
});

test('the report contributes only a guidance link when medical access was granted', async () => {
  medicalConsent = true;
  const { personalisation } = await readPlan();
  assert.equal(personalisation.context.hasConfirmedReport, true);
  assert.equal('report' in personalisation.draft, false);
});

test('valid consent enables the weight baseline and safety context but a declined weight still stays out', async () => {
  consent = true;
  const { personalisation } = await readPlan();
  assert.equal(personalisation.draft.targetWeight, 81);
  assert.ok(personalisation.draft.habits.includes('buddy'));
  assert.equal(personalisation.context.allergyContext, true);
  assert.equal(personalisation.context.clinicianContext, true);
  weightDeclined = true;
  assert.equal((await readPlan()).personalisation.draft.targetWeight, null);
  assert.ok(!reads.includes('weight'));
});

test('adding and removing steps changes the plan without changing stored answers', async () => {
  weightDeclined = false;
  const base = 'fitnessGoals,goalDetails';
  const original = (await readPlan('1', base)).personalisation;
  assert.equal(original.draft.type, 'weight');
  assert.deepEqual(original.draft.habits, ['walking']);
  assert.equal(original.draft.targetWeight, null);
  assert.equal(original.draft.window, null);
  assert.equal(original.context.clinicianContext, false);
  assert.ok(!reads.includes('weight'));
  assert.ok(!reads.includes('concern'));
  assert.ok(!reads.includes('prescription'));

  const expanded = (await readPlan('1',
    base + ',activityTime,bodyWeight,foodPreferences,healthConcerns,unknownFutureInput',
  )).personalisation;
  assert.equal(expanded.draft.targetWeight, 81);
  assert.equal(expanded.draft.window, 'evening');
  assert.equal(expanded.draft.diet, 'vegetarian');
  assert.equal(expanded.context.clinicianContext, true);
  assert.equal(expanded.context.allergyContext, false);
  assert.ok(!reads.includes('report'));

  const withoutGoals = (await readPlan('1', 'activityTime')).personalisation;
  assert.equal(withoutGoals.draft.type, 'routine');
  assert.deepEqual(withoutGoals.draft.habits, []);
  assert.equal(withoutGoals.draft.weightLossKg, null);
  assert.equal(withoutGoals.draft.window, 'evening');
  assert.equal(withoutGoals.draft.diet, null);
  assert.ok(!reads.includes('healthProfile'));
});

test('an explicitly empty flow uses neutral defaults and a wellness-only flow never inherits gym training', async () => {
  const { personalisation: neutral, onboardingInputsApplied } = await readPlan('1', '');
  assert.equal(onboardingInputsApplied, true);
  assert.equal(neutral.draft.type, 'routine');
  assert.deepEqual(neutral.draft.habits, []);
  assert.equal(neutral.draft.window, null);
  const wellness = (await readPlan('1', 'wellnessOnly')).personalisation;
  assert.equal(wellness.context.wellness, true);
  assert.deepEqual(wellness.draft.workouts, []);
  const training = (await readPlan('1', 'fitnessGoals,wellnessGoals,wellnessRoutine')).personalisation;
  assert.equal(training.context.wellness, false);
  assert.ok(training.draft.workouts.length > 0);
  assert.ok(training.draft.habits.includes('regular_schedule'));
});

test('a saved plan does not re-read onboarding or override the user’s edits', async () => {
  existing = {
    draft: { type: 'routine', walkDays: [1] }, completions: {}, revision: 1,
    schedule: [{ date: '2026-12-01', tasks: [{ key: 'walk', points: 10 }] }],
  };
  assert.equal((await readPlan()).plan.revision, 1);
  assert.deepEqual(reads, ['saved']);
});
