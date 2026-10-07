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
//
// Bounds travel with every response. They are rules, not styling: a kcal floor
// that differs between this service and the slider is a value the server
// refuses and the user can reproduce by dragging.
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

// Monday first, and the order the plan prefers to spread a week across: two
// hard days never land back to back, and Saturday - the day most people have
// free - is the fourth session rather than the first.
const WEEKDAY_PATTERN = [1, 3, 4, 6, 2, 5, 7];

// What a session IS, by goal. Chosen rather than generated: a plan that says
// "Workout 2" tells nobody what to do, and the menu is short enough that
// capping at seven sessions covers every day of the week.
const WORKOUT_MENU = {
  build_muscle: [
    { title: 'Push', focus: 'chest, shoulders, triceps', intensity: 'moderate' },
    { title: 'Pull', focus: 'back and biceps', intensity: 'moderate' },
    { title: 'Legs', focus: 'quads, glutes, hamstrings', intensity: 'hard' },
    { title: 'Upper body', focus: 'strength', intensity: 'moderate' },
    { title: 'Lower body', focus: 'strength', intensity: 'hard' },
    { title: 'Full body', focus: 'compound lifts', intensity: 'moderate' },
    { title: 'Mobility', focus: 'hips and shoulders', intensity: 'easy' },
  ],
  lose_fat: [
    { title: 'Zone 2 cardio', focus: 'conversational pace', intensity: 'easy' },
    { title: 'Full body circuit', focus: 'strength with the heart rate up', intensity: 'moderate' },
    { title: 'Intervals', focus: 'short hard efforts', intensity: 'hard' },
    { title: 'Strength basics', focus: 'squat, push, pull', intensity: 'moderate' },
    { title: 'Brisk walk', focus: 'recovery', intensity: 'easy' },
    { title: 'Conditioning', focus: 'carry, row, ride', intensity: 'moderate' },
    { title: 'Mobility', focus: 'hips and shoulders', intensity: 'easy' },
  ],
};

const DEFAULT_WORKOUT_MENU = [
  { title: 'Full body', focus: 'squat, push, pull', intensity: 'moderate' },
  { title: 'Zone 2 cardio', focus: 'conversational pace', intensity: 'easy' },
  { title: 'Strength basics', focus: 'compound lifts', intensity: 'moderate' },
  { title: 'Intervals', focus: 'short hard efforts', intensity: 'hard' },
  { title: 'Upper body', focus: 'strength', intensity: 'moderate' },
  { title: 'Lower body', focus: 'strength', intensity: 'moderate' },
  { title: 'Mobility', focus: 'hips and shoulders', intensity: 'easy' },
];

const FIELD_LABELS = {
  kcal: 'Calories',
  stepsPerDay: 'Steps a day',
  sleepMinutes: 'Sleep',
  sessionsPerWeek: 'Sessions a week',
};

// ---- Errors ---------------------------------------------------------------

// A refusal rather than a silent clamp, because the screen holds its sliders
// where the user left them and puts this sentence next to the button that
// failed. A 200 would let the client treat a rejected save as a success.
function outOfRange(field, value, bound) {
  const err = new Error(
    `${FIELD_LABELS[field]} ${formatValue(field, value)} is outside the range we can plan for `
    + `(${formatValue(field, bound.min)} - ${formatValue(field, bound.max)}).`,
  );
  err.status = 422;
  err.code = 'PRESCRIPTION_OUT_OF_RANGE';
  return err;
}

// Reached only when the intake never produced a target. The plan is arithmetic
// over height, weight, age and sex; without them there is no honest number to
// show, and a plausible-looking default is worse than an error the setup
// wizard can fix.
function unavailable() {
  const err = new Error('Set up your details first - the plan needs them before it can work one out.');
  err.status = 422;
  err.code = 'PRESCRIPTION_UNAVAILABLE';
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

// ---- Pure rules -----------------------------------------------------------

function clamp(value, bound) {
  if (!Number.isFinite(value)) return bound.min;
  return Math.min(bound.max, Math.max(bound.min, Math.round(value)));
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

/**
 * The step target a calorie budget implies, for a plan nobody has saved yet.
 *
 * The coupling the screen promises, in one direction and one direction only:
 * a bigger appetite buys more movement. The slope (5 steps per kcal, minus a
 * 3,000 offset) puts a 1,800 kcal plan at 6,000 steps and a 2,200 kcal plan at
 * 8,000, which are the two figures the app's own contract test holds up as the
 * sensible answers.
 *
 * It runs when building defaults and never over a value the user is dragging:
 * re-deriving on every preview would snap the step slider back mid-drag, which
 * is precisely the failure `adjustedBy` exists to make visible instead.
 */
export function deriveStepsPerDay(kcal) {
  const bound = PRESCRIPTION_BOUNDS.stepsPerDay;
  return clamp(roundToStep(5 * Number(kcal) - 3000, bound.step), bound);
}

/**
 * The slider ranges for THIS person.
 *
 * kcal's floor is the same eating-disorder guard computeTargets applies - never
 * below BMR, never below the absolute floor for their sex - rounded up to the
 * step so every reachable value stays at or above it. The ceiling is a multiple
 * of maintenance with an absolute floor, so a small person is not handed a cap
 * below their own target.
 */
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
  // A maintenance figure low enough that the multiple sits under the floor
  // would invert the slider. One step of headroom is the smallest fix that
  // keeps both bounds honest rather than widening the cap for everyone.
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

/**
 * The week's sessions, Monday first, spread so two hard days never collide.
 *
 * More sessions than days in the pattern wraps rather than dropping the
 * overflow: someone training 10-14 times a week is entitled to a plan that
 * acknowledges every one of them, and a two-a-day is a real thing.
 */
export function buildWorkout(sessionsPerWeek, goals) {
  const count = Math.max(0, Math.floor(Number(sessionsPerWeek) || 0));
  const goalList = normaliseGoals(goals);
  const menu = goalList.map((g) => WORKOUT_MENU[g]).find(Boolean) || DEFAULT_WORKOUT_MENU;

  const workout = [];
  for (let i = 0; i < count; i++) {
    const session = menu[i % menu.length];
    workout.push({
      weekday: WEEKDAY_PATTERN[i % WEEKDAY_PATTERN.length],
      title: session.title,
      focus: session.focus,
      intensity: session.intensity,
    });
  }
  return workout;
}

// ---- Assembly -------------------------------------------------------------

function pick(...values) {
  for (const v of values) if (v != null) return v;
  return undefined;
}

/**
 * Resolve the four adjustable numbers out of (request, saved, derived).
 *
 * `mode: 'write'` validates and refuses anything outside its bound - this is
 * the preview and the save. `mode: 'read'` clamps instead, because a saved
 * plan can legitimately fall out of range later (the person's weight moved, so
 * the kcal floor moved with it) and a GET that answered 422 would leave the
 * screen with no plan to show and nothing to fix.
 *
 * Anything the read path had to move is named in `adjustedBy`. The client uses
 * it to say "adjusted to fit your other changes" rather than silently showing
 * a number the user did not choose.
 */
function resolve(ctx, draft, mode) {
  const bounds = boundsFor(ctx.target);

  const requested = {
    kcal: pick(draft.kcal, ctx.saved?.kcal, Number(ctx.target.kcal)),
    stepsPerDay: pick(draft.stepsPerDay, ctx.saved?.stepsPerDay),
    sleepMinutes: pick(draft.sleepMinutes, ctx.saved?.sleepMinutes, DEFAULT_SLEEP_MINUTES),
    sessionsPerWeek: pick(
      draft.sessionsPerWeek,
      ctx.weekly?.sessionsPerWeek,
      NEUTRAL_DEFAULT,
    ),
  };
  // Only reachable on a first read: there is no saved step target, so the plan
  // derives one from the calorie budget it is about to show.
  if (requested.stepsPerDay == null) requested.stepsPerDay = deriveStepsPerDay(requested.kcal);

  const out = {};
  const adjustedBy = [];
  for (const field of Object.keys(bounds)) {
    const bound = bounds[field];
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

/**
 * Everything the response carries.
 *
 * protein, water and micros come off the stored target untouched: all three
 * are derived from body weight and age, not from the calorie budget, so
 * dragging the kcal slider must not move the number that matters most. Only
 * carbs, fat and fibre are re-split for the kcal currently on the table, and
 * they go through the same function computeTargets uses so the two screens can
 * never show different carbs for the same calories.
 */
function buildPlan(ctx, resolved) {
  const { target } = ctx;
  const proteinG = Number(target.proteinG);
  const inputs = target.inputs || {};
  const fatFraction = Number.isFinite(Number(inputs.fatFraction))
    ? Number(inputs.fatFraction)
    : defaultFatFraction();
  const { fatG, carbsG, fibreG } = splitMacrosForKcal({
    kcal: resolved.kcal,
    proteinG,
    fatFraction,
  });

  return {
    kcal: resolved.kcal,
    proteinG,
    carbsG,
    fatG,
    fibreG,
    waterMl: Number(target.waterMl),
    micros: target.micros || {},
    stepsPerDay: resolved.stepsPerDay,
    sleepMinutes: resolved.sleepMinutes,
    sessionsPerWeek: resolved.sessionsPerWeek,
    workout: buildWorkout(resolved.sessionsPerWeek, target.goals),
    bounds: resolved.bounds,
    adjustedBy: resolved.adjustedBy,
    // The version of the rules that produced THIS response, always current.
    // The row stores the version it was written under, which is what makes a
    // plan written before a retune explicable afterwards.
    rulesVersion: PRESCRIPTION_RULES_VERSION,
  };
}

async function loadContext(prisma, userId) {
  const target = await currentNutritionTarget(prisma, userId);
  if (!target) throw unavailable();

  const [weekly, saved] = await Promise.all([
    prisma.weeklyGoal.findUnique({ where: { userId } }),
    prisma.prescription.findUnique({ where: { userId } }),
  ]);
  return { target, weekly, saved };
}

// ---- Endpoints ------------------------------------------------------------

export async function getPlan({ prisma, userId }) {
  const ctx = await loadContext(prisma, userId);
  return buildPlan(ctx, resolve(ctx, {}, 'read'));
}

/**
 * What the draft would become. Reads only - the slider may be dragged a
 * hundred times and explored without cost, which is the whole point of
 * splitting preview from save.
 */
export async function previewPlan({ prisma, userId, draft = {} }) {
  const ctx = await loadContext(prisma, userId);
  return buildPlan(ctx, resolve(ctx, draft, 'write'));
}

export async function savePlan({ prisma, userId, draft = {} }) {
  const ctx = await loadContext(prisma, userId);
  const resolved = resolve(ctx, draft, 'write');

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

  // The session count lives in WeeklyGoal rather than here: the home ring
  // reads that row, and two sources of truth for one number is how the ring
  // and the plan screen come to disagree. Written only when the request
  // actually carried it, so a partial save cannot mark an untouched goal as
  // explicitly chosen.
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
    kcal: resolved.kcal,
    stepsPerDay: resolved.stepsPerDay,
    sleepMinutes: resolved.sleepMinutes,
  };

  return buildPlan(ctx, resolved);
}
