// The adjustable plan behind the app's "Your plan" screen: calories, steps,
// sleep and sessions a week, with the macros and the week's workouts that
// follow from them.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the client may ask what a plan looks
// like, but it may not answer. It sends exactly four integers and gets a whole
// plan back. Macros, water, micros and the workout schedule are derived here
// from the NutritionTarget the intake already computed - never accepted from
// the request - because a client that supplies its own protein target is a
// client whose numbers can disagree with the targets screen's for the same
// person on the same day.
//
// Three endpoints share one shape (GET, preview, PUT) so a screen that renders
// a preview renders a save without a second parser:
//
//   getPlan      read the saved plan, or the defaults when there is none
//   previewPlan  the same computation over an unsaved draft - NEVER writes
//   savePlan     validate, persist, and return the same shape back
//   saveSettings validate, persist the 4 ints, rebuild slots on sessionsPerWeek change, rebuildPlan('edit')
//   saveSlots    validate and persist the slot array, then rebuildPlan('edit')
//
// Bounds travel with every response. They are rules, not styling: a kcal floor
// that differs between this service and the slider is a value the server
// refuses and the user can reproduce by dragging.
//
// The coach journey (UB4): all paths now take a journey context. The legacy
// WORKOUT_MENU/buildWorkout and the 422-without-target path are deleted.
import { currentNutritionTarget } from './currentTarget.js';
import {
  DEFAULT_SLEEP_MINUTES,
  PRESCRIPTION_BOUNDS,
  PRESCRIPTION_RULES_VERSION,
  SAFETY,
} from './constants.js';
import { defaultFatFraction, normaliseGoals, splitMacrosForKcal } from './targetEngine.js';
import {
  MAX_SESSIONS_PER_WEEK,
  MIN_SESSIONS_PER_WEEK,
  NEUTRAL_DEFAULT,
} from '../goalService.js';
import { isScopeStale, NUTRITION_SCOPE } from './ledgerConsentService.js';
import { buildWorkoutSlots } from './starterPlanService.js';
import { rebuildPlan } from '../plan/rebuildPlan.js';
import { getOnLayerKeys } from '../plan/layerState.js';
import { JOURNEY, DEFAULT_STEPS, DEFAULT_SLEEP_MIN, startLayerFor } from '../journey/journeyConfig.js';

const JOURNEY_DEFAULT_WATER_ML = 2500;

const FIELD_LABELS = {
  kcal: 'Calories',
  stepsPerDay: 'Steps a day',
  sleepMinutes: 'Sleep',
  sessionsPerWeek: 'Sessions a week',
};

function outOfRange(field, value, bound) {
  const err = new Error(
    `${FIELD_LABELS[field]} ${formatValue(field, value)} is outside the range we can plan for `
    + `(${formatValue(field, bound.min)} - ${formatValue(field, bound.max)}).`,
  );
  err.status = 422;
  err.code = 'PRESCRIPTION_OUT_OF_RANGE';
  return err;
}

function formatValue(field, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (field === 'stepsPerDay') return `${Math.round(n).toLocaleString('en-IN')} steps`;
  if (field === 'kcal') return `${Math.round(n).toLocaleString('en-IN')} kcal`;
  if (field === 'sessionsPerWeek') return `${Math.round(n)}`;
  if (field === 'sleepMinutes') {
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  return String(value);
}

function clamp(value, bound) {
  if (!Number.isFinite(value)) return bound.min;
  return Math.min(bound.max, Math.max(bound.min, Math.round(value)));
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

export function deriveStepsPerDay(kcal) {
  const bound = PRESCRIPTION_BOUNDS.stepsPerDay;
  return clamp(roundToStep(5 * Number(kcal) - 3000, bound.step), bound);
}

export function boundsFor(target) {
  const inputs = target?.inputs || {};
  const sex = inputs.sex;
  const floorBySex =
    sex === 'male' ? SAFETY.kcalFloorMale
      : sex === 'female' ? SAFETY.kcalFloorFemale
        : SAFETY.kcalFloorOther;

  const { step, capFactor, capFloor } = PRESCRIPTION_BOUNDS.kcal;
  const min = roundToStep(Math.ceil(Math.max(Number(inputs.bmrKcal) || 0, floorBySex) / step) * step, step);
  const maintenance = Number(inputs.maintenanceKcal) || 0;
  let max = Math.max(capFloor, roundToStep(maintenance * capFactor, step));
  if (max <= min) max = min + step;

  return {
    kcal: { min, max, step },
    stepsPerDay: { ...PRESCRIPTION_BOUNDS.stepsPerDay },
    sleepMinutes: { ...PRESCRIPTION_BOUNDS.sleepMinutes },
    sessionsPerWeek: {
      min: MIN_SESSIONS_PER_WEEK,
      max: MAX_SESSIONS_PER_WEEK,
      step: 1,
    },
  };
}

function pick(...values) {
  for (const v of values) if (v != null) return v;
  return undefined;
}

function buildPlan(ctx, resolved, journey = null) {
  const { target } = ctx;
  const inputs = target?.inputs || {};
  const fatFraction = Number.isFinite(Number(inputs.fatFraction))
    ? Number(inputs.fatFraction)
    : defaultFatFraction();

  let macros = null;
  if (target) {
    const proteinG = Number(target.proteinG);
    const { fatG, carbsG, fibreG } = splitMacrosForKcal({
      kcal: resolved.kcal,
      proteinG,
      fatFraction,
    });
    macros = { proteinG, carbsG, fatG, fibreG };
  }

  const plan = {
    kcal: resolved.kcal,
    proteinG: macros ? macros.proteinG : null,
    carbsG: macros ? macros.carbsG : null,
    fatG: macros ? macros.fatG : null,
    fibreG: macros ? macros.fibreG : null,
    waterMl: target ? Number(target.waterMl) : JOURNEY_DEFAULT_WATER_ML,
    micros: target ? target.micros || {} : {},
    stepsPerDay: resolved.stepsPerDay,
    sleepMinutes: resolved.sleepMinutes,
    sessionsPerWeek: resolved.sessionsPerWeek,
    bounds: resolved.bounds,
    adjustedBy: resolved.adjustedBy,
    rulesVersion: PRESCRIPTION_RULES_VERSION,
  };

  if (!journey) return plan;

  // Journey additions: workoutSlots, foodSetupNeeded, bodyDataNeeded, diet
  const stored = Array.isArray(ctx.saved?.workoutSlots) ? ctx.saved.workoutSlots : [];
  plan.workoutSlots = stored.map((slot) => ({
    weekday: Number(slot?.weekday),
    templateId: slot?.templateId ?? null,
    title: String(slot?.title ?? ''),
    level: slot?.level ?? null,
  }));
  if (stored.length > 0) {
    plan.workout = stored.map((slot) => ({
      weekday: Number(slot?.weekday) + 1,
      title: String(slot?.title ?? ''),
      focus: null,
      intensity: null,
    }));
  }

  plan.foodSetupNeeded = ctx.foodSetupNeeded;
  plan.bodyDataNeeded = ctx.bodyDataNeeded;
  plan.diet = ctx.healthGoal?.diet ?? null;
  if (journey.wellnessOnly) {
    plan.wellnessOnly = true;
    plan.wellnessFocuses = journey.wellnessFocuses ?? [];
    plan.wellnessDayPattern = journey.wellnessDayPattern ?? null;
    plan.wellnessSleepPattern = journey.wellnessSleepPattern ?? null;
    plan.sessionsPerWeek = 0;
    plan.workoutSlots = [];
    delete plan.workout;
  }

  return plan;
}

async function loadJourneyExtras(prisma, userId, target, journey) {
  const [healthGoal, consent] = await Promise.all([
    prisma.healthGoal.findUnique({ where: { userId } }),
    prisma.healthConsent.findUnique({ where: { userId } }),
  ]);
  const foodUnlocked = (journey.unlockedLayerKeys || []).includes('food');
  const hasConsent = Boolean(
    consent
    && !consent.revokedAt
    && (consent.scopes || []).includes(NUTRITION_SCOPE)
    && !isScopeStale(consent, NUTRITION_SCOPE),
  );
  return {
    healthGoal,
    foodSetupNeeded: foodUnlocked && (!hasConsent || !target),
    bodyDataNeeded: !target,
  };
}

async function loadContext(prisma, userId, journey = null) {
  const target = await currentNutritionTarget(prisma, userId);

  const [weekly, saved] = await Promise.all([
    prisma.weeklyGoal.findUnique({ where: { userId } }),
    prisma.prescription.findUnique({ where: { userId } }),
  ]);
  const ctx = { target, weekly, saved };
  if (journey) Object.assign(ctx, await loadJourneyExtras(prisma, userId, target, journey));
  return ctx;
}

function resolve(ctx, draft, mode, { allowNullKcal = false } = {}) {
  const bounds = boundsFor(ctx.target);

  const requested = {
    kcal: pick(draft.kcal, ctx.saved?.kcal, ctx.target ? Number(ctx.target.kcal) : null),
    stepsPerDay: pick(draft.stepsPerDay, ctx.saved?.stepsPerDay),
    sleepMinutes: pick(draft.sleepMinutes, ctx.saved?.sleepMinutes, DEFAULT_SLEEP_MINUTES),
    sessionsPerWeek: pick(
      draft.sessionsPerWeek,
      ctx.weekly?.sessionsPerWeek,
      NEUTRAL_DEFAULT,
    ),
  };
  if (requested.stepsPerDay == null) requested.stepsPerDay = deriveStepsPerDay(requested.kcal);

  const out = {};
  const adjustedBy = [];
  for (const field of Object.keys(bounds)) {
    const bound = bounds[field];
    if (allowNullKcal && field === 'kcal' && requested.kcal == null) {
      out[field] = null;
      continue;
    }
    const value = Number(requested[field]);
    const inRange = Number.isInteger(value) && value >= bound.min && value <= bound.max;
    if (inRange) {
      out[field] = value;
      continue;
    }
    if (mode === 'write') throw outOfRange(field, requested[field], bound);
    out[field] = clamp(value, bound);
    if (out[field] !== value) adjustedBy.push(field);
  }

  return { ...out, bounds, adjustedBy };
}

export async function getPlan({ prisma, userId, journey = null }) {
  const ctx = await loadContext(prisma, userId, journey);
  return buildPlan(ctx, resolve(ctx, {}, 'read', { allowNullKcal: true }), journey);
}

export async function previewPlan({ prisma, userId, draft = {}, journey = null }) {
  const ctx = await loadContext(prisma, userId, journey);
  return buildPlan(ctx, resolve(ctx, draft, 'write', { allowNullKcal: true }), journey);
}

export async function savePlan({ prisma, userId, draft = {}, journey = null }) {
  const ctx = await loadContext(prisma, userId, journey);
  const resolved = resolve(ctx, draft, 'write', { allowNullKcal: true });

  await prisma.prescription.upsert({
    where: { userId },
    create: {
      userId,
      kcal: resolved.kcal,
      stepsPerDay: resolved.stepsPerDay,
      sleepMinutes: resolved.sleepMinutes,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
    update: {
      kcal: resolved.kcal,
      stepsPerDay: resolved.stepsPerDay,
      sleepMinutes: resolved.sleepMinutes,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
  });

  if (draft.sessionsPerWeek != null) {
    await prisma.weeklyGoal.upsert({
      where: { userId },
      create: {
        userId,
        sessionsPerWeek: resolved.sessionsPerWeek,
        setByUser: true,
      },
      update: { sessionsPerWeek: resolved.sessionsPerWeek, setByUser: true },
    });
    ctx.weekly = { sessionsPerWeek: resolved.sessionsPerWeek, setByUser: true };
  }

  ctx.saved = {
    ...ctx.saved,
    kcal: resolved.kcal,
    stepsPerDay: resolved.stepsPerDay,
    sleepMinutes: resolved.sleepMinutes,
  };

  return buildPlan(ctx, resolved, journey);
}

/**
 * Save settings (kcal, stepsPerDay, sleepMinutes, sessionsPerWeek).
 * The 4-int rule: only these four integers are accepted.
 * kcal only when Food layer is on.
 * A sessionsPerWeek change rebuilds slots using buildWorkoutSlots, then rebuildPlan('edit').
 */
export async function saveSettings({ prisma, userId, draft = {}, journey = null }) {
  // Validate 4-int rule
  const allowedFields = ['kcal', 'stepsPerDay', 'sleepMinutes', 'sessionsPerWeek'];
  for (const key of Object.keys(draft)) {
    if (!allowedFields.includes(key)) {
      const err = new Error(`Unexpected field: ${key}. Only kcal, stepsPerDay, sleepMinutes, sessionsPerWeek are allowed.`);
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (draft[key] != null && !Number.isInteger(Number(draft[key]))) {
      const err = new Error(`${key} must be an integer`);
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
  }

  // Check kcal requires Food layer on
  if (draft.kcal != null) {
    const onLayerKeys = await getOnLayerKeys(prisma, userId, { journey });
    if (!onLayerKeys.includes('food')) {
      const err = new Error('Calorie target can only be set when the Food layer is on');
      err.status = 409;
      err.code = 'LAYER_NOT_ON';
      err.layer = 'food';
      throw err;
    }
  }

  const ctx = await loadContext(prisma, userId, journey);
  const resolved = resolve(ctx, draft, 'write', { allowNullKcal: true });

  // Check if sessionsPerWeek changed
  const sessionsChanged = draft.sessionsPerWeek != null &&
    draft.sessionsPerWeek !== ctx.weekly?.sessionsPerWeek;

  await prisma.prescription.upsert({
    where: { userId },
    create: {
      userId,
      kcal: resolved.kcal,
      stepsPerDay: resolved.stepsPerDay,
      sleepMinutes: resolved.sleepMinutes,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
    update: {
      kcal: resolved.kcal,
      stepsPerDay: resolved.stepsPerDay,
      sleepMinutes: resolved.sleepMinutes,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
  });

  let slots = ctx.saved?.workoutSlots ?? [];
  if (sessionsChanged) {
    const experienceLevel = journey?.startLevel ?? 'new_to_gym';
    const homeRoutineHints = ['no equipment', 'bodyweight', '15 minute', '10 minute', 'no bar', 'mobility', 'desk reset', 'low-impact'];
    const location = slots.length > 0
      ? (slots.some((s) => homeRoutineHints.some((hint) => s.title?.toLowerCase().includes(hint))) ? 'home' : 'gym')
      : 'gym';
    slots = await buildWorkoutSlots(prisma, {
      experienceLevel,
      location,
      sessions: resolved.sessionsPerWeek,
      goals: ctx.healthGoal?.goals ?? [],
      userId,
      // Changing the count adds or drops days around the ones already planned.
      keepWeekdays: slots.map((slot) => slot.weekday),
    });

    await prisma.prescription.update({
      where: { userId },
      data: { workoutSlots: slots },
    });

    await prisma.weeklyGoal.upsert({
      where: { userId },
      create: {
        userId,
        sessionsPerWeek: resolved.sessionsPerWeek,
        setByUser: true,
      },
      update: { sessionsPerWeek: resolved.sessionsPerWeek, setByUser: true },
    });
    ctx.weekly = { sessionsPerWeek: resolved.sessionsPerWeek, setByUser: true };
  }

  ctx.saved = {
    ...ctx.saved,
    kcal: resolved.kcal,
    stepsPerDay: resolved.stepsPerDay,
    sleepMinutes: resolved.sleepMinutes,
    workoutSlots: slots,
  };

  // Rebuild plan if sessions changed or any other setting changed
  if (sessionsChanged || draft.kcal != null || draft.stepsPerDay != null || draft.sleepMinutes != null) {
    await rebuildPlan(prisma, userId, { reason: 'edit' });
  }

  return buildPlan(ctx, resolved, journey);
}

/**
 * Save slots array.
 * Validation: weekdays unique (0-6), each template must be system or user's own.
 * Sets sessionsPerWeek = slots.length, then rebuildPlan('edit').
 */
export async function saveSlots({ prisma, userId, slots = [], journey = null }) {
  if (!Array.isArray(slots)) {
    const err = new Error('slots must be an array');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
  if (slots.length > 7) {
    const err = new Error('Maximum 7 slots allowed (one per weekday)');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }

  // Validate weekdays unique and in range
  const weekdays = new Set();
  for (const slot of slots) {
    if (!Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6) {
      const err = new Error('weekday must be an integer 0-6 (0 = Monday)');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (weekdays.has(slot.weekday)) {
      const err = new Error('Duplicate weekday in slots');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    weekdays.add(slot.weekday);
  }

  // Validate templateIds are system or user's own
  if (slots.length > 0) {
    const templateIds = slots.map((s) => s.templateId).filter(Boolean);
    if (templateIds.length > 0) {
      const templates = await prisma.workoutTemplate.findMany({
        where: { id: { in: templateIds } },
        select: { id: true, userId: true, isSystem: true },
      });
      const validIds = new Set(
        templates
          .filter((t) => t.isSystem || t.userId === userId)
          .map((t) => t.id)
      );
      for (const id of templateIds) {
        if (!validIds.has(id)) {
          const err = new Error(`Template ${id} not found or not accessible`);
          err.status = 400;
          err.code = 'VALIDATION';
          throw err;
        }
      }
    }
  }

  const ctx = await loadContext(prisma, userId, journey);
  const sessionsPerWeek = slots.length;

  await prisma.prescription.upsert({
    where: { userId },
    create: {
      userId,
      kcal: ctx.saved?.kcal ?? null,
      stepsPerDay: ctx.saved?.stepsPerDay ?? DEFAULT_STEPS,
      sleepMinutes: ctx.saved?.sleepMinutes ?? DEFAULT_SLEEP_MINUTES,
      workoutSlots: slots,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
    update: {
      workoutSlots: slots,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
  });

  await prisma.weeklyGoal.upsert({
    where: { userId },
    create: {
      userId,
      sessionsPerWeek,
      setByUser: true,
    },
    update: { sessionsPerWeek, setByUser: true },
  });
  ctx.weekly = { sessionsPerWeek, setByUser: true };
  ctx.saved = { ...ctx.saved, workoutSlots: slots };

  await rebuildPlan(prisma, userId, { reason: 'edit' });

  return buildPlan(ctx, { ...resolve(ctx, {}, 'read', { allowNullKcal: true }), sessionsPerWeek }, journey);
}

export { buildPlan };
