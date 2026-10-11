// The coach journey's plan engine (B7): the starter plan a new member gets
// on day one, and the rebuild that keeps it honest afterwards.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the starter plan must exist before
// the person has given us anything a calorie target needs. A first-timer who
// has answered four questions (level, goals, days, location) gets a plan with
// real workout slots in it - not a 422 asking for their height, and not a
// plausible-looking default budget invented for them. kcal stays null until
// body data produces a NutritionTarget; the plan is workouts and water until
// then, which is the part a beginner can actually follow.
//
// Two entry points, both called by B9:
//
//   createStarterPlan   /journey/start - writes the goal, the session count,
//                        the prescription defaults and the week's slots.
//   regenerateForUser    layer unlock, accept-refresh, ease-back and start -
//                        rebuilds the slots for the current level and
//                        location and replaces the auto-generated plan items,
//                        never touching a doctor's or the user's own.
import { currentNutritionTarget } from './currentTarget.js';
import * as prescriptionService from './prescriptionService.js';
import * as ledgerPlanService from './ledgerPlanService.js';
import { layerKeysUpTo } from './planGenerator.js';
import { normaliseGoals } from './targetEngine.js';
import { DEFAULT_SLEEP_MINUTES, PRESCRIPTION_RULES_VERSION } from './constants.js';
import { NEUTRAL_DEFAULT } from '../goalService.js';

// The coach journey's default water, before any body data exists. Same value
// as JOURNEY.defaultWaterMl in the Contracts.
const JOURNEY_DEFAULT_WATER_ML = 2500;

// ---- The journey's own constants (copied; TODO(B9): journeyConfig.js) ------
//
// Both maps below are copied from the Contracts (B9's journeyConfig.js is
// read-only for B7 and does not exist yet). Replace them with an import once
// B9 lands; the two must not drift in the meantime.

// Starting layer per experience level. new_to_gym begins with workouts and
// water only; an on-off user starts with food unlocked too; a regular starts
// with everything (their locks become milestones instead).
const START_LAYER = { new_to_gym: 1, restarting_after_break: 2, experienced: 5 };

// The step and sleep targets written into the starter prescription, before
// any body data exists. Sleep is the same seven hours for everyone (the
// range the sleep literature treats as adequate for an adult, and a number
// nobody has to be talked into); steps scale with the level a person
// claims, because a target a beginner clears is the target a beginner keeps.
const LEVEL_DEFAULTS = {
  new_to_gym: { stepsPerDay: 6000, sleepMinutes: DEFAULT_SLEEP_MINUTES },
  restarting_after_break: { stepsPerDay: 8000, sleepMinutes: DEFAULT_SLEEP_MINUTES },
  experienced: { stepsPerDay: 8000, sleepMinutes: DEFAULT_SLEEP_MINUTES },
};

const DEFAULT_EXPERIENCE_LEVEL = 'new_to_gym';

function levelDefaults(experienceLevel) {
  return LEVEL_DEFAULTS[experienceLevel] ?? LEVEL_DEFAULTS[DEFAULT_EXPERIENCE_LEVEL];
}

// Which template difficulty each experience level's slots ask for. Nothing in
// the gym pool is harder than beginner yet, so an experienced gym user falls
// back to the beginner pool - the honest alternative would be inventing
// intermediate gym content this task does not own.
const TEMPLATE_LEVEL_BY_EXPERIENCE = {
  new_to_gym: 'beginner',
  restarting_after_break: 'beginner',
  experienced: 'intermediate',
};

// ---- The week's slot shape -------------------------------------------------
//
// Slot weekdays are 0 = Monday .. 6 = Sunday (the Prescription.workoutSlots
// contract, matching A3's parser). The spread pattern is the same shape the
// legacy menu uses - no two hard days back to back, Saturday before the
// lighter weekdays - so a journey week and a pre-journey week agree on what
// "three sessions a week" looks like.
const SLOT_WEEKDAY_PATTERN = [0, 2, 3, 5, 1, 4, 6];

// The gym pool: the four starter routines ported from the customer app
// (prisma/seedBeginnerTemplates.js). The first three sessions of a beginner
// week are all "Full Body x3 - Beginner-friendly" - the routine whose own
// description says "train 3 days a week", and the one the app's starter week
// shows - and a fourth session onwards brings in the split.
const GYM_TEMPLATE_POOL = {
  beginner: [
    'Full Body x3 — Beginner-friendly',
    'Full Body x3 — Beginner-friendly',
    'Full Body x3 — Beginner-friendly',
    'Push Day A',
    'Leg Day',
    'Upper & Abs',
    'Full Body x3 — Beginner-friendly',
  ],
  intermediate: [],
};

// The home pool: the no-equipment system routines seedHomeTrack.js already
// ships, so a home user's plan is built from content that exists rather than
// gym machinery they do not have.
const HOME_TEMPLATE_POOL = {
  beginner: [
    'Full body — 15 minute',
    'Full body — no equipment',
    'Core — 10 minute',
    'Low-impact cardio (no jumping)',
    'Push — bodyweight',
    'Pull — no bar',
    'Legs — bodyweight',
    'Mobility & stretch',
    'Desk reset — 8 minute',
  ],
  intermediate: [
    'Full body — intermediate',
    'Push — intermediate',
    'Legs — intermediate',
  ],
};

function poolFor(location, requestedLevel) {
  const pool = location === 'home' ? HOME_TEMPLATE_POOL : GYM_TEMPLATE_POOL;
  // A pool with nothing at the requested difficulty falls back to beginner
  // rather than producing a week of null templates: a plan that says
  // "Workout" tells nobody what to do.
  return pool[requestedLevel]?.length ? pool[requestedLevel] : pool.beginner;
}

/**
 * The week's slots: one per session, spread across the week, each naming the
 * template the Plan tab will offer on that day.
 *
 * Pure apart from the template lookup, so tests can pin the spread and the
 * count without a database.
 */
export async function buildWorkoutSlots(prisma, { experienceLevel, location, sessions }) {
  const count = Math.max(0, Math.floor(Number(sessions) || 0));
  if (count === 0) return [];

  const requestedLevel = TEMPLATE_LEVEL_BY_EXPERIENCE[experienceLevel] ?? 'beginner';
  const names = poolFor(location, requestedLevel);

  const rows = await prisma.workoutTemplate.findMany({
    where: { isSystem: true, name: { in: [...new Set(names)] } },
  });
  const byName = new Map(rows.map((r) => [r.name, r]));

  const slots = [];
  for (let i = 0; i < count; i++) {
    const name = names[i % names.length];
    const template = byName.get(name);
    slots.push({
      weekday: SLOT_WEEKDAY_PATTERN[i % SLOT_WEEKDAY_PATTERN.length],
      templateId: template?.id ?? null,
      title: template?.name ?? name,
      // The template's own difficulty, not the level that was asked for: a
      // slot that says "intermediate" while pointing at a beginner routine
      // would be a label the content does not match.
      level: template?.level ?? requestedLevel,
    });
  }
  return slots;
}

// ---- Errors ----------------------------------------------------------------

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The day a plan is built on, as the user's IST day string - the same
// convention HealthGoal.startDate and BiometricEntry.localDate carry.
function todayLocalDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// ---- The starter plan ------------------------------------------------------

/**
 * Build a member's first plan. Called by B9's POST /journey/start, and safe
 * to call again (the upserts update).
 *
 * Writes, in order: the goals (in the user's own order), the session count
 * the ring reads, the prescription's level defaults (kcal null until body
 * data produces a target), and the week's workout slots - one per
 * daysPerWeek, spread across the week, templates by level and location.
 */
export async function createStarterPlan(prisma, userId, {
  experienceLevel = null,
  goals = [],
  daysPerWeek,
  location,
} = {}) {
  const level = experienceLevel ?? DEFAULT_EXPERIENCE_LEVEL;
  if (experienceLevel != null && !(level in LEVEL_DEFAULTS)) {
    throw badRequest(`experienceLevel must be one of: ${Object.keys(LEVEL_DEFAULTS).join(', ')}`);
  }
  if (location !== 'gym' && location !== 'home') {
    throw badRequest('location must be "gym" or "home"');
  }
  const sessions = Number(daysPerWeek);
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 7) {
    throw badRequest('daysPerWeek must be an integer between 1 and 7');
  }
  // normaliseGoals keeps the user's order, drops anything that is not a real
  // goal, and de-duplicates - exactly the contract for "goals in the user's
  // order". An empty set is accepted: onboarding's goal step is skippable,
  // and the plan still works; food simply stays "not set up" until they
  // answer it.
  const goalList = normaliseGoals(goals);

  const [existingGoal, target] = await Promise.all([
    prisma.healthGoal.findUnique({ where: { userId } }),
    currentNutritionTarget(prisma, userId),
  ]);

  // Goals only. Sex, age, height, diet and activity belong to their own
  // surfaces (bodyDataService, saveDiet, the intake); a starter plan that
  // clobbered any of them would be the number moving under the user.
  await prisma.healthGoal.upsert({
    where: { userId },
    create: { userId, goals: goalList, startDate: existingGoal?.startDate ?? todayLocalDate() },
    update: { goals: goalList },
  });

  // The session count is the user's own answer, so the ring and the plan
  // start from the same number.
  await prisma.weeklyGoal.upsert({
    where: { userId },
    create: { userId, sessionsPerWeek: sessions, setByUser: true },
    update: { sessionsPerWeek: sessions, setByUser: true },
  });

  const defaults = levelDefaults(level);
  const slots = await buildWorkoutSlots(prisma, { experienceLevel: level, location, sessions });
  await prisma.prescription.upsert({
    where: { userId },
    create: {
      userId,
      // Null until height + weight give a NutritionTarget. A null budget is
      // not a zero-calorie plan - it is the state where the plan can be
      // followed but its food numbers cannot.
      kcal: target ? Number(target.kcal) : null,
      stepsPerDay: defaults.stepsPerDay,
      sleepMinutes: defaults.sleepMinutes,
      workoutSlots: slots,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
    update: {
      kcal: target ? Number(target.kcal) : null,
      stepsPerDay: defaults.stepsPerDay,
      sleepMinutes: defaults.sleepMinutes,
      workoutSlots: slots,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
  });

  // The plan, in the same shape the prescription read serves - B9's
  // /journey/start returns { journey, plan } and this is the plan half.
  return prescriptionService.getPlan({
    prisma,
    userId,
    journey: { unlockedLayerKeys: layerKeysUpTo(START_LAYER[level]) },
  });
}

// ---- Rebuilding ------------------------------------------------------------

/**
 * The unlocked layer keys for a user, for callers that do not have them.
 *
 * TODO(B9): once services/journey/journeyService.js exists, its
 * `getUnlockedLayerKeys(userId)` is the answer. Until then (and for any caller
 * that wants the pre-journey truth) layer 1 is what a journey user has:
 * workouts and water, nothing else. The dynamic import means this file does
 * not depend on B9's existing to load, and picks B9's answer up the moment it
 * merges.
 */
export async function resolveUnlockedLayerKeys(userId) {
  try {
    const mod = await import('../journey/journeyService.js');
    const keys = await mod.getUnlockedLayerKeys?.(userId);
    if (Array.isArray(keys) && keys.length) return keys;
  } catch {
    // B9 not merged yet - the layer-1 fallback below is the honest state.
  }
  return ['workout', 'water'];
}

// Which pool the stored slots were built from, so a rebuild keeps training
// where the user actually trains. Pre-journey rows have no slots and default
// to the gym branch - the marketplace's own default.
function locationFromSlots(slots) {
  if (!Array.isArray(slots)) return null;
  const gymNames = new Set(Object.values(GYM_TEMPLATE_POOL).flat());
  const homeNames = new Set(Object.values(HOME_TEMPLATE_POOL).flat());
  for (const slot of slots) {
    const title = String(slot?.title ?? '');
    if (gymNames.has(title)) return 'gym';
    if (homeNames.has(title)) return 'home';
  }
  return null;
}

/**
 * Rebuild the week's slots and the auto-generated plan items. B9 calls this
 * when a layer unlocks, when a refresh is accepted, on ease-back, and at
 * start.
 *
 * Never touches a doctor's or the user's own items - that guarantee is
 * ledgerPlanService.regenerateSuggestions's own (origin 'suggested' only),
 * reused here rather than re-implemented, because "regenerate is safe to
 * press" is the one property this path must not lose.
 *
 * `easeBack` halves the week's sessions (minimum 1) without touching
 * WeeklyGoal: the user's standing goal is not lowered because they were
 * away for a week; only this week's plan is lighter.
 */
export async function regenerateForUser(prisma, userId, {
  unlockedLayerKeys = null,
  easeBack = false,
} = {}) {
  const keys = Array.isArray(unlockedLayerKeys) && unlockedLayerKeys.length
    ? unlockedLayerKeys
    : await resolveUnlockedLayerKeys(userId);

  const [progress, weekly, saved] = await Promise.all([
    prisma.journeyProgress.findUnique({ where: { userId } }),
    prisma.weeklyGoal.findUnique({ where: { userId } }),
    prisma.prescription.findUnique({ where: { userId } }),
  ]);

  const level = progress?.startLevel ?? DEFAULT_EXPERIENCE_LEVEL;
  const defaults = levelDefaults(level);
  const sessionsPerWeek = weekly?.sessionsPerWeek ?? NEUTRAL_DEFAULT;
  const sessions = easeBack ? Math.max(1, Math.floor(sessionsPerWeek / 2)) : sessionsPerWeek;

  const location = locationFromSlots(saved?.workoutSlots) ?? 'gym';
  const slots = await buildWorkoutSlots(prisma, { experienceLevel: level, location, sessions });

  await prisma.prescription.upsert({
    where: { userId },
    // The create side carries the starter defaults, so a rebuild for a user
    // who never started (no row yet) still produces a coherent prescription;
    // the update side touches ONLY the slots - steps and sleep are the user's
    // sliders' to move, not the rebuild's.
    create: {
      userId,
      kcal: null,
      stepsPerDay: defaults.stepsPerDay,
      sleepMinutes: defaults.sleepMinutes,
      workoutSlots: slots,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
    update: { workoutSlots: slots },
  });

  const [goal, target] = await Promise.all([
    prisma.healthGoal.findUnique({ where: { userId } }),
    currentNutritionTarget(prisma, userId),
  ]);

  const regenerated = await ledgerPlanService.regenerateSuggestions(prisma, {
    userId,
    goals: goal?.goals ?? [],
    diet: goal?.diet ?? null,
    targets: target
      ? {
          kcal: Number(target.kcal),
          proteinG: Number(target.proteinG),
          carbsG: Number(target.carbsG),
          fatG: Number(target.fatG),
          fibreG: Number(target.fibreG),
          waterMl: Number(target.waterMl),
          micros: target.micros,
        }
      : null,
    unlockedLayerKeys: keys,
    workoutSlots: slots,
    stepsPerDay: saved?.stepsPerDay ?? defaults.stepsPerDay,
  });

  return { sessions, slots, regenerated };
}

export { JOURNEY_DEFAULT_WATER_ML, START_LAYER, LEVEL_DEFAULTS };
