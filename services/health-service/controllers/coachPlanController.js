import prisma from '../db/prisma.js';
import * as todayService from '../services/plan/todayService.js';
import { getPlanToday, setPlanToday } from '../utils/planResponseCache.js';
import { rebuildPlan } from '../services/plan/rebuildPlan.js';
import * as prescriptionService from '../services/ledger/prescriptionService.js';
import * as ledgerPlanService from '../services/ledger/ledgerPlanService.js';
import { getMedicalRecordsConsentService } from '../services/ledger/ledgerConsentService.js';
import { getJourney, invalidateJourneyCaches, unlockFoodEarly } from '../services/journey/journeyService.js';
import { track } from '../utils/analytics.js';
import { goalPlanView, normalizeGoalDraft, prepareGoalPlan, recordGoalTask, saveGoalPlan } from '../services/plan/goalPlanService.js';
import { getNutritionConsentService } from '../services/ledger/ledgerConsentService.js';
import { currentNutritionTarget } from '../services/ledger/currentTarget.js';
import { isoDayIST } from '../utils/sessionDay.js';
import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';
import { hasCoachScopeService } from '../services/coachConsentService.js';
import { hasBiometricConsentService } from '../services/biometricConsentService.js';
import { hasHealthProfileConsentService } from '../services/healthProfileConsentService.js';
import { suggestGoalPlan } from '../services/plan/goalPlanPersonalisation.js';
import { goalPlanHealthSelect, goalPlanProfile, readOnboardingInputs } from '../services/plan/goalPlanOnboardingInputs.js';
import { goalActivitySources, readGoalActivity } from '../services/plan/goalPlanActivity.js';


function handle(fn) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[coachPlan]', err);
      return res.status(status).json({
        error: err.error || err.message || 'Server error',
        code: err.code,
        ...(err.layer ? { layer: err.layer } : {}),
        ...(err.field ? { field: err.field } : {}),
      });
    }
  };
}

// GET /plan/today
export const getToday = handle(async (req, res) => {
  const localDate = req.query.localDate;
  const cacheDate = localDate ?? todayService.todayIST();
  const today = await getPlanToday(req.userId, cacheDate, () =>
    todayService.buildToday(prisma, req.userId, { localDate: cacheDate }),
  );
  res.json(today);
});

// GET /plan
export const getPlan = handle(async (req, res) => {
  const plan = await todayService.buildPlanDefinition(prisma, req.userId);
  res.json(plan);
});

export const getGoalPlan = handle(async (req, res) => {
  const { userId } = req;
  const current = await prisma.goalPlan.findUnique({ where: { userId } });
  if (current) return res.json(await withGoalActivity(userId, goalPlanView(current)));
  if (req.query.suggest !== '1') return res.json(goalPlanView(null));
  const onboarding = readOnboardingInputs(req.query.onboardingInputs);
  const uses = (input) => !onboarding || onboarding.has(input);
  const healthSelect = goalPlanHealthSelect(onboarding);
  const usesPrescription = ['trainingHistory', 'trainingLocation', 'fitnessGoals', 'workoutFrequency'].every(uses);
  const [profile, basic, nutritionConsent, biometric, healthProfileConsent, medicalConsent, health] = await Promise.all([
    fetchUserProfileInternal(userId, { purpose: 'goal_plan' }),
    (usesPrescription || uses('returnBarrier')) && hasCoachScopeService(userId, 'basic'),
    getNutritionConsentService(userId),
    uses('bodyWeight') && hasBiometricConsentService(userId),
    (uses('allergies') || uses('healthConcerns')) && hasHealthProfileConsentService(userId),
    uses('reportGuidance') && getMedicalRecordsConsentService(userId),
    Object.keys(healthSelect).length ? prisma.healthProfile.findUnique({
      where: { userId },
      select: healthSelect,
    }) : null,
  ]);
  const today = isoDayIST();
  const [prescription, nutrition, weight, journey, allergy, concern, guidance] = await Promise.all([
    // Starter prescriptions may encode omitted training answers.
    basic && usesPrescription ? prisma.prescription.findUnique({ where: { userId } }) : null,
    nutritionConsent.granted && !nutritionConsent.needsReconsent
      ? currentNutritionTarget(prisma, userId)
      : null,
    biometric && !health?.weightDeclined ? prisma.biometricEntry.findFirst({
      where: { userId, metric: 'weight', unit: 'kg', source: 'manual', localDate: { lte: today } },
      orderBy: { localDate: 'desc' }, select: { value: true },
    }) : null,
    basic && uses('returnBarrier') ? prisma.journeyProgress.findUnique({ where: { userId }, select: { quitReason: true } }) : null,
    healthProfileConsent && uses('allergies') ? prisma.healthProfile.findUnique({ where: { userId }, select: { allergyStatus: true } }) : null,
    healthProfileConsent && uses('healthConcerns') ? prisma.healthCondition.findFirst({ where: { userId, source: 'user_stated' }, select: { id: true } }) : null,
    medicalConsent?.granted && !medicalConsent.needsReconsent
      ? prisma.guidanceProfile.findUnique({ where: { userId }, select: { confirmedAt: true } })
      : null,
  ]);
  const slots = prescription?.workoutSlots ?? [];
  const templateIds = slots.map((slot) => slot.templateId).filter(Number.isInteger);
  const templates = templateIds.length ? await prisma.workoutTemplate.findMany({
    where: { id: { in: templateIds }, OR: [{ userId }, { isSystem: true }] },
    select: { id: true, name: true, estMinutes: true, exercises: {
      take: 12, orderBy: { order: 'asc' }, select: {
        targetSets: true, targetReps: true, targetDurationSeconds: true,
        exercise: { select: { name: true } },
      },
    } },
  }) : [];
  const byId = new Map(templates.map((template) => [template.id, template]));
  const seed = {
    steps: prescription?.stepsPerDay,
    sleepMinutes: prescription?.sleepMinutes,
    waterMl: nutrition?.waterMl,
    nutrition: nutrition ? {
      kcal: Number(nutrition.kcal), protein: Number(nutrition.proteinG), fat: Number(nutrition.fatG),
    } : null,
    workouts: slots.map((slot, index) => {
      const template = byId.get(slot.templateId);
      return {
        id: `seed-${index}`, weekday: slot.weekday, title: (slot.title || template?.name)?.slice(0, 80),
        minutes: Math.min(180, Math.max(5, template?.estMinutes ?? 30)),
        exercises: template?.exercises.map((move) => ({
          name: move.exercise.name.slice(0, 80),
          sets: Math.min(20, Math.max(1, move.targetSets ?? 1)),
          ...(move.targetDurationSeconds
            ? { seconds: Math.min(600, move.targetDurationSeconds) }
            : { reps: Math.min(100, Math.max(1, move.targetReps ?? 10)) }),
        })) ?? [],
      };
    }),
  };
  const personalisation = profile || onboarding ? suggestGoalPlan({
    profile: goalPlanProfile(profile, onboarding), health: health ?? {}, quitReason: journey?.quitReason, seed, today,
    body: { weightKg: weight?.value == null ? null : Number(weight.value) },
    sensitive: { allergyStatus: allergy?.allergyStatus, hasIssue: Boolean(concern) },
    hasConfirmedReport: Boolean(guidance?.confirmedAt),
    includeWellnessGoals: onboarding?.has('wellnessGoals') === true,
  }) : null;
  res.json({
    ...goalPlanView(null, today), seed, personalisation,
    ...(onboarding ? { onboardingInputsApplied: true } : {}),
  });
});

async function withGoalActivity(userId, response) {
  const { plan, today } = response;
  if (!plan) return response;
  const days = [...plan.history, ...plan.schedule].filter(day => day.date <= today);
  const sources = await goalActivitySources(userId, days);
  const activity = await readGoalActivity(prisma, userId, days, sources);
  const view = goalPlanView({ ...plan, schedule: [...plan.history, ...plan.schedule] }, today, activity);
  return { ...view, sources };
}

async function validateGoalNutrition(userId, draft, current) {
  if (!draft.nutrition) return;
  const { kcal } = draft.nutrition;
  if (kcal === current?.draft?.nutrition?.kcal) return;
  const consent = await getNutritionConsentService(userId);
  if (!consent.granted || consent.needsReconsent) return;
  const target = await currentNutritionTarget(prisma, userId);
  if (!target || kcal === Number(target.kcal)) return;
  const { min, max } = prescriptionService.boundsFor(target).kcal;
  if (kcal < min || kcal > max) {
    throw Object.assign(new Error(`Calories must be between ${min} and ${max} for this plan`), { status: 400 });
  }
}

export const previewGoalPlan = handle(async (req, res) => {
  const current = await prisma.goalPlan.findUnique({ where: { userId: req.userId } });
  const draft = normalizeGoalDraft(req.body?.draft);
  await validateGoalNutrition(req.userId, draft, current);
  const today = isoDayIST();
  res.json(goalPlanView({ ...prepareGoalPlan(draft, current, today), revision: current?.revision ?? 0 }, today));
});

export const putGoalPlan = handle(async (req, res) => {
  const draft = normalizeGoalDraft(req.body?.draft);
  const current = await prisma.goalPlan.findUnique({ where: { userId: req.userId } });
  await validateGoalNutrition(req.userId, draft, current);
  const saved = await saveGoalPlan(prisma, req.userId, { draft, revision: req.body?.revision });
  if (saved.plan.revision !== current?.revision) {
    if (!current) {
      track('goal_plan_saved', req.userId, {});
    } else if (saved.plan.startDate === current.startDate) {
      track('goal_plan_edited', req.userId, {});
    } else {
      track('goal_plan_phase_started', req.userId, {});
    }
  }
  res.json(await withGoalActivity(req.userId, saved));
});

export const putGoalPlanTask = handle(async (req, res) => {
  const saved = await recordGoalTask(prisma, req.userId, req.body || {});
  res.json(await withGoalActivity(req.userId, saved));
});

// POST /plan/items/:id/complete
export const completeItem = handle(async (req, res) => {
  const { id } = req.params;
  const { localDate } = req.body || {};

  // Validate date if provided
  if (localDate && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    const err = new Error('localDate must be YYYY-MM-DD');
    err.status = 400;
    err.code = 'VALIDATION';
    err.field = 'localDate';
    throw err;
  }
  if (localDate && todayService.isFutureDate(localDate)) {
    const err = new Error('Cannot complete for a future date');
    err.status = 400;
    err.code = 'VALIDATION';
    err.field = 'localDate';
    throw err;
  }

  const item = await prisma.planItem.findFirst({ where: { id: Number(id), userId: req.userId } });
  if (!item) {
    const err = new Error('Plan item not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!item.active) {
    const err = new Error('That item is not active');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }

  // Check layer is on
  const onLayerKeys = await todayService.getOnLayerKeys(prisma, req.userId);
  if (item.layerKey && !onLayerKeys.includes(item.layerKey)) {
    const err = new Error('This plan layer is not active');
    err.status = 409;
    err.code = 'LAYER_NOT_ON';
    err.layer = item.layerKey;
    throw err;
  }

  const completed = await ledgerPlanService.completeItem(prisma, {
    userId: req.userId,
    planItemId: Number(id),
    localDate: localDate || todayService.todayIST(),
    how: 'manual',
  });

  // Emit analytics
  track('plan_item_completed', req.userId, {
    row_kind: item.kind,
    layer: item.layerKey,
  });

  const today = await todayService.buildToday(prisma, req.userId, { localDate });
  setPlanToday(req.userId, localDate ?? todayService.todayIST(), today);
  res.json({ today });
});

// DELETE /plan/items/:id/complete
export const uncompleteItem = handle(async (req, res) => {
  const { id } = req.params;
  const { localDate } = req.query;

  if (localDate && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    const err = new Error('localDate must be YYYY-MM-DD');
    err.status = 400;
    err.code = 'VALIDATION';
    err.field = 'localDate';
    throw err;
  }

  const item = await prisma.planItem.findFirst({ where: { id: Number(id), userId: req.userId } });
  if (!item) {
    const err = new Error('Plan item not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  try {
    await ledgerPlanService.uncompleteItem(prisma, {
      userId: req.userId,
      planItemId: Number(id),
      localDate: localDate || todayService.todayIST(),
    });
  } catch (err) {
    if (err.status === 409 && err.code === 'AUTO_DONE') {
      throw err;
    }
    throw err;
  }

  const today = await todayService.buildToday(prisma, req.userId, { localDate });
  setPlanToday(req.userId, localDate ?? todayService.todayIST(), today);
  res.json({ today });
});

// POST /plan/items
export const createItem = handle(async (req, res) => {
  const { type, ...data } = req.body || {};

  if (type === 'own') {
    const { title, ownKind, schedule } = data;
    if (!title || !ownKind || !schedule) {
      const err = new Error('title, ownKind, and schedule are required');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (!['habit', 'workout'].includes(ownKind)) {
      const err = new Error('ownKind must be habit or workout');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (title.length > 60) {
      const err = new Error('Title must be 60 characters or less');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    const activeCount = await prisma.planItem.count({ where: { userId: req.userId, active: true } });
    if (activeCount >= 20) {
      const err = new Error('Your plan already has 20 active items. Remove one to add another.');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    const item = await prisma.planItem.create({
      data: {
        userId: req.userId,
        kind: ownKind,
        title: title.trim(),
        schedule: schedule.trim(),
        origin: 'user',
        ownKind,
        active: true,
        autoGenerated: false,
      },
    });

    track('plan_edited', req.userId, { what: 'item_added' });

    const today = await todayService.buildToday(prisma, req.userId, {});
    setPlanToday(req.userId, todayService.todayIST(), today);
    res.status(201).json({ item, today });
  } else if (type === 'doctor') {
    const { kind, title, schedule, prescribedBy, prescribedNote, endsOn } = data;
    if (!kind || !title || !schedule) {
      const err = new Error('kind, title, and schedule are required');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (!['doctor_medication', 'doctor_test', 'doctor_appointment'].includes(kind)) {
      const err = new Error('kind must be doctor_medication, doctor_test, or doctor_appointment');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    // Check medical_records consent
    const consent = await getMedicalRecordsConsentService(req.userId);
    if (!consent.granted || consent.needsReconsent) {
      const err = new Error('Medical records consent required');
      err.status = 403;
      err.code = 'CONSENT_REQUIRED';
      err.scope = 'medical_records';
      throw err;
    }

    const activeCount = await prisma.planItem.count({ where: { userId: req.userId, active: true } });
    if (activeCount >= 20) {
      const err = new Error('Your plan already has 20 active items. Remove one to add another.');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    const item = await prisma.planItem.create({
      data: {
        userId: req.userId,
        kind,
        title: title.trim(),
        schedule: schedule.trim(),
        origin: 'doctor',
        prescribedBy: prescribedBy?.trim() || null,
        prescribedNote: prescribedNote?.trim() || null,
        endsOn: endsOn || null,
        active: true,
        autoGenerated: false,
        layerKey: kind === 'doctor_appointment' ? 'health' : 'medicine',
      },
    });

    track('plan_edited', req.userId, { what: 'item_added' });

    const today = await todayService.buildToday(prisma, req.userId, {});
    setPlanToday(req.userId, todayService.todayIST(), today);
    res.status(201).json({ item, today });
  } else {
    const err = new Error('type must be "own" or "doctor"');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
});

// DELETE /plan/items/:id
export const deleteItem = handle(async (req, res) => {
  const { id } = req.params;

  const item = await prisma.planItem.findFirst({ where: { id: Number(id), userId: req.userId } });
  if (!item) {
    const err = new Error('Plan item not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (item.origin === 'suggested') {
    const err = new Error('Suggested items cannot be deleted directly. Change them through settings or slots.');
    err.status = 409;
    err.code = 'SUGGESTED_ROW';
    throw err;
  }

  await prisma.planItem.update({ where: { id: item.id }, data: { active: false } });

  track('plan_edited', req.userId, { what: 'item_removed' });

  const today = await todayService.buildToday(prisma, req.userId, {});
  setPlanToday(req.userId, todayService.todayIST(), today);
  res.json({ today });
});

// POST /plan/settings/preview
export const previewSettings = handle(async (req, res) => {
  const draft = req.body || {};
  const journey = await getJourney(req.userId);
  const plan = await prescriptionService.previewPlan({ prisma, userId: req.userId, draft, journey });
  res.json({ plan });
});

// PUT /plan/settings
export const saveSettings = handle(async (req, res) => {
  const draft = req.body || {};
  const journey = await getJourney(req.userId);
  const { plan, today } = await prescriptionService.saveSettings({ prisma, userId: req.userId, draft, journey });
  track('plan_edited', req.userId, { what: 'settings' });
  res.json({ plan, today });
});

// PUT /plan/slots
export const saveSlots = handle(async (req, res) => {
  const { slots } = req.body || {};
  if (!Array.isArray(slots)) {
    const err = new Error('slots must be an array');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
  const journey = await getJourney(req.userId);
  await prescriptionService.saveSlots({ prisma, userId: req.userId, slots, journey });
  invalidateJourneyCaches(req.userId);
  const [plan, today] = await Promise.all([
    todayService.buildPlanDefinition(prisma, req.userId),
    todayService.buildToday(prisma, req.userId, {}),
  ]);
  setPlanToday(req.userId, todayService.todayIST(), today);
  track('plan_edited', req.userId, { what: 'slots' });
  res.json({ plan, today });
});

// POST /plan/layers/food/early
export const foodEarly = handle(async (req, res) => {
  await unlockFoodEarly(req.userId);

  const today = await todayService.buildToday(prisma, req.userId, {});
  setPlanToday(req.userId, todayService.todayIST(), today);
  res.json({ today });
});
