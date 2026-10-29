import { isoDayIST } from '../../utils/sessionDay.js';
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
// Entry points:
//
//   createStarterPlan   /journey/start - writes the goal, the session count,
//                        the prescription defaults and the week's slots,
//                        then rebuildPlan({reason:'start'}) for the rows.
//   regenerateForUser    layer unlock and friends - a one-line wrapper over
//                        rebuildPlan({reason:'unlock'}). Slot reshaping on
//                        unlock is UB4's saveSlots; this only diffs rows.
import { currentNutritionTarget } from './currentTarget.js';
import * as prescriptionService from './prescriptionService.js';
import { rebuildPlan } from '../plan/rebuildPlan.js';
import { layerKeysUpTo, JOURNEY } from '../journey/journeyConfig.js';
import { normaliseGoals } from './targetEngine.js';
import { DEFAULT_SLEEP_MINUTES, PRESCRIPTION_RULES_VERSION } from './constants.js';
import { equipmentFit } from '../homeSetup.js';

// Aliases kept for callers/tests that import these names from here; the
// values live in journeyConfig and must not drift from it.
export const JOURNEY_DEFAULT_WATER_ML = JOURNEY.defaultWaterMl;
export const START_LAYER = JOURNEY.startLayer;

// The step and sleep targets written into the starter prescription, before
// any body data exists. Sleep is the same seven hours for everyone (the
// range the sleep literature treats as adequate for an adult, and a number
// nobody has to be talked into); steps scale with the level a person
// claims, because a target a beginner clears is the target a beginner keeps.
const LEVEL_DEFAULTS = {
  new_to_gym: { stepsPerDay: 6000, sleepMinutes: DEFAULT_SLEEP_MINUTES },
  just_started: { stepsPerDay: 6000, sleepMinutes: DEFAULT_SLEEP_MINUTES },
  restarting_after_break: { stepsPerDay: 8000, sleepMinutes: DEFAULT_SLEEP_MINUTES },
  experienced: { stepsPerDay: 8000, sleepMinutes: DEFAULT_SLEEP_MINUTES },
};

const DEFAULT_EXPERIENCE_LEVEL = 'new_to_gym';

function levelDefaults(experienceLevel) {
  return LEVEL_DEFAULTS[experienceLevel] ?? LEVEL_DEFAULTS[DEFAULT_EXPERIENCE_LEVEL];
}

function journeyExperienceForProfile(profile, fallback) {
  return ({
    none: 'new_to_gym',
    lt_1_year: 'new_to_gym',
    one_to_three_years: 'restarting_after_break',
    over_three_years: 'experienced',
  })[profile?.experienceLevel] ?? fallback;
}

// Which template difficulty each experience level's slots ask for. Nothing in
// the gym pool is harder than beginner yet, so an experienced gym user falls
// back to the beginner pool - the honest alternative would be inventing
// intermediate gym content this task does not own.
const TEMPLATE_LEVEL_BY_EXPERIENCE = {
  new_to_gym: 'beginner',
  just_started: 'beginner',
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

// A fitness centre or sports preference does not mean the user wants a
// weight-based gym routine. Begin with general movement and mobility work.
const MOVEMENT_TEMPLATE_POOL = {
  beginner: [
    'Low-impact cardio (no jumping)',
    'Mobility & stretch',
    'Desk reset — 8 minute',
  ],
  intermediate: [
    'Low-impact cardio (no jumping)',
    'Mobility & stretch',
    'Desk reset — 8 minute',
  ],
};

function poolFor(location, requestedLevel) {
  const pool = location === 'home'
    ? HOME_TEMPLATE_POOL
    : location === 'gym'
      ? GYM_TEMPLATE_POOL
      : MOVEMENT_TEMPLATE_POOL;
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
function goalFit(template, goals = []) {
  const groups = new Set((template.exercises ?? []).map((row) => row.exercise?.muscleGroup));
  const name = template.name.toLowerCase();
  let score = 0;
  for (const [index, goal] of goals.entries()) {
    const priority = Math.max(1, goals.length - index);
    if (goal === 'build_muscle' || goal === 'recomp') {
      if (groups.has('chest') || groups.has('back') || groups.has('legs') || groups.has('shoulders')) score += 3 * priority;
      if (/strength|push|pull|legs|upper|full body/.test(name)) score += 2 * priority;
    } else if (goal === 'endurance' || goal === 'lose_fat') {
      if (groups.has('cardio')) score += 3 * priority;
      if (/cardio|full body|conditioning|low-impact/.test(name)) score += 2 * priority;
    } else if (goal === 'general_health') {
      if (groups.has('fullBody') || groups.has('cardio')) score += 2 * priority;
      if (/mobility|full body|low-impact/.test(name)) score += 2 * priority;
    }
  }
  return score;
}

function injuryBias(template, profile) {
  // Injury preferences affect recommendations only after the user opted into
  // personalised programming. This is a gentle template ranking signal, not a
  // diagnosis or a promise that an exercise is safe for a particular injury.
  if (!profile?.consentAt || !profile.injuryZones?.length) return 0;
  const groups = new Set((template.exercises ?? []).map((row) => row.exercise?.muscleGroup));
  const affectedGroups = new Set();
  for (const zone of profile.injuryZones) {
    if (zone === 'knee') ['legs', 'cardio'].forEach((x) => affectedGroups.add(x));
    if (['shoulder', 'wrist', 'neck'].includes(zone)) ['shoulders', 'chest', 'arms'].forEach((x) => affectedGroups.add(x));
    if (zone === 'lower_back') ['back', 'core', 'legs'].forEach((x) => affectedGroups.add(x));
  }
  return [...groups].some((group) => affectedGroups.has(group)) ? -2 : 0;
}

function planWeekdays(sessions, preferredRestDay) {
  // Profile uses Sunday=0; prescription slots use Monday=0.
  if (sessions >= 7) return [...SLOT_WEEKDAY_PATTERN];
  const restWeekday = preferredRestDay == null ? null : (preferredRestDay + 6) % 7;
  const available = SLOT_WEEKDAY_PATTERN.filter((day) => day !== restWeekday);
  const days = [];
  for (let i = 0; i < sessions; i++) days.push(available[i % available.length]);
  return days;
}

export async function buildWorkoutSlots(prisma, {
  experienceLevel, location, sessions, goals = [], userId = null,
}) {
  const count = Math.max(0, Math.floor(Number(sessions) || 0));
  if (count === 0) return [];

  const requestedLevel = TEMPLATE_LEVEL_BY_EXPERIENCE[experienceLevel] ?? 'beginner';
  const names = poolFor(location, requestedLevel);

  const [rows, profile, recentSessions] = await Promise.all([
    prisma.workoutTemplate.findMany({
    where: { isSystem: true, name: { in: [...new Set(names)] } },
      include: { exercises: { include: { exercise: true } } },
    }),
    userId && prisma.personalisationProfile?.findUnique
      ? prisma.personalisationProfile.findUnique({ where: { userId } }) : null,
    userId && prisma.workoutSession?.findMany ? prisma.workoutSession.findMany({
      where: { userId, templateId: { not: null }, endedAt: { not: null } },
      orderBy: { startedAt: 'desc' }, take: 8, select: { templateId: true },
    }) : [],
  ]);
  const byName = new Map(rows.map((r) => [r.name, r]));
  const recentIds = new Set(recentSessions.map((session) => session.templateId));
  const rankedCandidates = [...byName.values()].map((template) => {
    const fit = location === 'home' ? equipmentFit(template, profile) : null;
    const lowImpactPreference = profile?.programmingMode === 'low_impact_recovery';
    const lowImpact = /low-impact|mobility|stretch/i.test(template.name);
    const smallSpaceFit = profile?.trainingSpace === 'small'
      ? (/low-impact|mobility|desk reset|10 minute|15 minute/i.test(template.name) ? 4 : -2)
      : 0;
    return {
      template,
      equipmentFits: fit?.fits,
      score: goalFit(template, goals)
        + (fit?.fits === true ? 5 : fit?.fits === false ? -8 : 0)
        + (lowImpactPreference && lowImpact ? 8 : 0)
        + smallSpaceFit
        + injuryBias(template, profile)
        - (recentIds.has(template.id) ? 2 : 0),
    };
  }).sort((a, b) => b.score - a.score || a.template.id - b.template.id);
  const fittingCandidates = location === 'home' && profile?.homeSetupAt
    ? rankedCandidates.filter((candidate) => candidate.equipmentFits === true)
    : [];
  const candidates = fittingCandidates.length ? fittingCandidates : rankedCandidates;
  const hasPersonalContext = goals.length > 0 || recentIds.size > 0 || Boolean(
    profile?.experienceLevel || profile?.preferredRestDay != null || profile?.homeSetupAt
      || profile?.trainingSpace || profile?.programmingMode === 'low_impact_recovery'
      || (profile?.consentAt && profile?.injuryZones?.length),
  );

  const slots = [];
  const weekdays = planWeekdays(count, profile?.preferredRestDay);
  for (let i = 0; i < count; i++) {
    // Cycle through the ranked catalog while avoiding consecutive duplicates
    // whenever the selected pool contains alternatives.
    const name = names[i % names.length];
    const alternatives = hasPersonalContext ? candidates.filter((candidate) =>
      i === 0 || candidate.template.id !== slots[i - 1].templateId,
    ) : [];
    const template = hasPersonalContext
      ? (alternatives.length ? alternatives : candidates)[0]?.template
      : byName.get(name);
    const fallbackName = name;
    slots.push({
      weekday: weekdays[i],
      location,
      templateId: template?.id ?? null,
      title: template?.name ?? fallbackName,
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
  return isoDayIST(new Date());
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
  wellnessOnly = false,
  wellnessProfile = null,
} = {}) {
  const level = experienceLevel ?? DEFAULT_EXPERIENCE_LEVEL;
  if (experienceLevel != null && !(level in LEVEL_DEFAULTS)) {
    throw badRequest(`experienceLevel must be one of: ${Object.keys(LEVEL_DEFAULTS).join(', ')}`);
  }
  if (!['gym', 'home', 'fitness_centre', 'sports', 'other'].includes(location)) {
    throw badRequest('location must be one of: gym, home, fitness_centre, sports, other');
  }
  const sessions = Number(daysPerWeek);
  if (!wellnessOnly && (!Number.isInteger(sessions) || sessions < 1 || sessions > 7)) {
    throw badRequest('daysPerWeek must be an integer between 1 and 7');
  }
  // normaliseGoals keeps the user's order, drops anything that is not a real
  // goal, and de-duplicates - exactly the contract for "goals in the user's
  // order". An empty set is accepted: onboarding's goal step is skippable,
  // and the plan still works; food simply stays "not set up" until they
  // answer it.
  const goalList = wellnessOnly ? [] : normaliseGoals(goals);

  const [existingGoal, target] = await Promise.all([
    prisma.healthGoal.findUnique({ where: { userId } }),
    currentNutritionTarget(prisma, userId),
  ]);

  // Goals only. Sex, age, height, diet and activity belong to their own
  // surfaces (bodyDataService, saveDiet, the intake); a starter plan that
  // clobbered any of them would be the number moving under the user.
  if (!wellnessOnly) {
    await prisma.healthGoal.upsert({
      where: { userId },
      create: { userId, goals: goalList, startDate: existingGoal?.startDate ?? todayLocalDate() },
      update: { goals: goalList },
    });
  }

  // The session count is the user's own answer, so the ring and the plan
  // start from the same number.
  if (!wellnessOnly) await prisma.weeklyGoal.upsert({
    where: { userId },
    create: { userId, sessionsPerWeek: sessions, setByUser: true },
    update: { sessionsPerWeek: sessions, setByUser: true },
  });

  const profile = await prisma.personalisationProfile?.findUnique?.({ where: { userId } });
  const profileLevel = journeyExperienceForProfile(profile, level);
  const defaults = levelDefaults(profileLevel);
  const focuses = new Set(wellnessProfile?.wellnessFocuses ?? []);
  const stepsByPattern = { mostly_seated: 2500, mixed: 4000, mostly_on_feet: 6000, variable_schedule: 3000 };
  const wellnessSteps = stepsByPattern[wellnessProfile?.wellnessDayPattern] ?? 3000;
  const slots = wellnessOnly ? [] : await buildWorkoutSlots(prisma, {
    experienceLevel: profileLevel,
    location,
    sessions,
    goals: goalList,
    userId,
  });
  await prisma.prescription.upsert({
    where: { userId },
    create: {
      userId,
      // Null until height + weight give a NutritionTarget. A null budget is
      // not a zero-calorie plan - it is the state where the plan can be
      // followed but its food numbers cannot.
      kcal: target ? Number(target.kcal) : null,
      stepsPerDay: wellnessOnly ? wellnessSteps : defaults.stepsPerDay,
      sleepMinutes: defaults.sleepMinutes,
      workoutSlots: slots,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
    update: {
      kcal: target ? Number(target.kcal) : null,
      stepsPerDay: wellnessOnly ? wellnessSteps : defaults.stepsPerDay,
      sleepMinutes: defaults.sleepMinutes,
      workoutSlots: slots,
      rulesVersion: PRESCRIPTION_RULES_VERSION,
    },
  });

  // The plan rows themselves. rebuildPlan reads the prescription just
  // written (slots/steps/sleep) plus the on-layer keys, so the starter
  // plan's suggested rows exist before /journey/start returns.
  await rebuildPlan(prisma, userId, { reason: 'start' });

  // The plan, in the same shape the prescription read serves - B9's
  // /journey/start returns { journey, plan } and this is the plan half.
  return prescriptionService.getPlan({
    prisma,
    userId,
    journey: wellnessOnly
      ? { unlockedLayerKeys: ['water', ...(focuses.has('balanced_eating') ? ['food'] : []), ...((focuses.has('daily_movement') || focuses.has('energy')) ? ['steps'] : []), ...((focuses.has('sleep') || focuses.has('energy')) ? ['sleep'] : [])], wellnessOnly: true, wellnessFocuses: [...focuses] }
      : { unlockedLayerKeys: layerKeysUpTo(START_LAYER[level]) },
  });
}

// Rebuild workout slots when a user changes a training preference. Profile
// changes never alter manually authored plan items; rebuildPlan only diffs
// suggested rows.
export async function refreshWorkoutSlotsForProfile(prisma, userId) {
  if (!prisma.prescription?.findUnique || !prisma.prescription?.update) return false;
  const [prescription, journey, goal, profile] = await Promise.all([
    prisma.prescription.findUnique({ where: { userId } }),
    prisma.journeyProgress?.findUnique?.({ where: { userId } }),
    prisma.healthGoal.findUnique({ where: { userId } }),
    prisma.personalisationProfile?.findUnique?.({ where: { userId } }),
  ]);
  if (journey?.wellnessOnly) return false;
  if (!prescription?.workoutSlots?.length) return false;
  const homeNames = new Set(Object.values(HOME_TEMPLATE_POOL).flat());
  const location = prescription.workoutSlots[0]?.location
    ?? (prescription.workoutSlots.some((slot) => homeNames.has(slot.title)) ? 'home' : 'gym');
  const experienceLevel = journeyExperienceForProfile(profile, journey?.startLevel ?? DEFAULT_EXPERIENCE_LEVEL);
  const slots = await buildWorkoutSlots(prisma, {
    experienceLevel,
    location,
    sessions: prescription.workoutSlots.length,
    goals: goal?.goals ?? [],
    userId,
  });
  await prisma.prescription.update({ where: { userId }, data: { workoutSlots: slots } });
  await rebuildPlan(prisma, userId, { reason: 'personalisation' });
  return true;
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

/**
 * Rebuild the suggested plan rows — a one-line wrapper over rebuildPlan so
 * there is exactly one rebuild implementation. Legacy options
 * (unlockedLayerKeys/easeBack) are accepted and ignored: on-layer keys now
 * come from layerState on every rebuild, and slot reshaping is UB4's
 * saveSlots, not this path's. Never touches a doctor's or the user's own
 * items — rebuildPlan diffs origin 'suggested' only.
 */
export async function regenerateForUser(prisma, userId, _options = {}) {
  return rebuildPlan(prisma, userId, { reason: 'unlock' });
}

export { LEVEL_DEFAULTS };
