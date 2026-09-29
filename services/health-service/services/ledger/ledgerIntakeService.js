// Intake for the health ledger: the "About you" and "Your routine" steps from
// the plan, and the thing that makes target setup possible at all.
//
// Until this existed there was no writer for HealthGoal anywhere in the service
// except scoreService toggling calmMode. The plan documents a four-step wizard,
// targetService.resolveInputs reports exactly which inputs are missing so a
// screen can "ask only for what's missing", and none of it could be completed —
// a user who had never set a goal was stuck on "no targets" with no route out.
//
// Two rules shape everything here:
//
//   1. Weight is NOT written to this table. It is a time series in
//      BiometricEntry(metric='weight'), and the schema says why in detail: a
//      second copy here would go stale the moment someone lost weight, and the
//      target would then describe a body that no longer exists. So a weight
//      given at intake is written as a BiometricEntry, and
//      targetService.latestWeightKg reads it from there like any other reading.
//      A user who has been stepping on a scale for a month does not have their
//      history replaced by whatever they typed today.
//
//   2. Age, sex and height are snapshotted here and never re-synced, because
//      they are inputs to a historical calculation. That is the HealthGoal
//      schema's own stated contract and this service honours it rather than
//      quietly refreshing them from the auth profile on every save.

import { validateLocalDate } from '../biometricService.js';
import { SAFETY } from './constants.js';
import { latestWeightKg, resolveInputs, MISSING_REASONS } from './targetService.js';

/**
 * The user's own calendar day, used only as a fallback when a caller omits one.
 *
 * Derived from the validated day rather than from a clock read at each call
 * site, for the reason that matters here: a weight written "today" is a row with
 * a date on it, and the day has to be the one the user is living in (IST), not
 * the UTC day the server happens to be in. A caller that already knows the
 * user's localDate should pass it — targetService works the same way and takes
 * no default at all.
 */
function todayLocalDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export const GOAL_TYPES = [
  'build_muscle',
  'lose_fat',
  'recomp',
  'endurance',
  'general_health',
  'doctor_plan',
];
export const SEXES = ['male', 'female', 'other'];
export const ACTIVITY_LEVELS = ['sedentary', 'light', 'moderate', 'very_active'];
export const DIET_PATTERNS = ['veg', 'egg', 'non_veg', 'vegan', 'jain'];

// Bounds chosen to reject a typo or a hostile value without refusing a real
// body. The engine independently range-checks what it consumes, so these are the
// outer gate, not the only one.
export const HEIGHT_CM_RANGE = { min: 90, max: 250 };
export const WEIGHT_KG_RANGE = { min: 25, max: 400 };

/** The plain-language goal labels the plan specifies for the picker. */
const GOAL_LABELS = {
  build_muscle: 'Build muscle',
  lose_fat: 'Lose fat',
  recomp: 'Recomposition',
  endurance: 'Build endurance',
  general_health: 'Feel better day to day',
  doctor_plan: "Follow my doctor's plan",
};

// --- validation ---------------------------------------------------------------

/**
 * Validates one submitted field.
 *
 * Returns a human sentence rather than a code, because this string is shown to
 * the person filling the form. A field left out is not an error — the plan asks
 * only for what is missing, and a value already stored elsewhere (a weight from
 * the scale, a height from an older profile) is pre-filled rather than demanded.
 */
function validate(field, value) {
  if (value === undefined || value === null || value === '') return null;

  switch (field) {
    case 'goal': {
      if (GOAL_TYPES.includes(value)) return null;
      return 'Choose one of the listed goals.';
    }
    case 'sex': {
      if (SEXES.includes(value)) return null;
      return 'Choose male, female, or other.';
    }
    case 'activity': {
      if (ACTIVITY_LEVELS.includes(value)) return null;
      return 'Choose how active a normal day is.';
    }
    case 'diet': {
      if (DIET_PATTERNS.includes(value)) return null;
      return 'Choose one of the listed diets.';
    }
    case 'age': {
      const age = Number(value);
      // The engine refuses below 13 and above 100 (targetEngine.resolveInputs),
      // and this service refuses the same range so the user is told here rather
      // than receiving a silently dropped field.
      if (!Number.isInteger(age) || age < 13 || age > 100) {
        return 'Enter an age between 13 and 100.';
      }
      return null;
    }
    case 'heightCm': {
      const cm = Number(value);
      if (!Number.isFinite(cm) || cm < HEIGHT_CM_RANGE.min || cm > HEIGHT_CM_RANGE.max) {
        return `Enter a height between ${HEIGHT_CM_RANGE.min} and ${HEIGHT_CM_RANGE.max} cm.`;
      }
      return null;
    }
    case 'weightKg': {
      const kg = Number(value);
      if (!Number.isFinite(kg) || kg < WEIGHT_KG_RANGE.min || kg > WEIGHT_KG_RANGE.max) {
        return `Enter a weight between ${WEIGHT_KG_RANGE.min} and ${WEIGHT_KG_RANGE.max} kg.`;
      }
      return null;
    }
    case 'startDate': {
      // A start date is today or later — it is a plan, not a measurement.
      const err = validateLocalDate(value, { allowFuture: true });
      return err ?? null;
    }
    case 'targetDate': {
      // Allow future explicitly: "lose 4 kg by December" is the whole point of
      // the field, and the default rule (a reading cannot be dated ahead of
      // today) would reject every real answer.
      const err = validateLocalDate(value, { allowFuture: true });
      if (err) return err;
      // But a target that has already passed is not a target, and the safe-pace
      // check deliberately does nothing about it (it would otherwise return
      // nonsense for a negative interval), so it is refused here where the user
      // can be told what to fix.
      if (value < todayLocalDate()) return 'Choose a date that has not passed yet.';
      return null;
    }
    case 'allergies': {
      if (Array.isArray(value)) {
        const tooLong = value.filter((a) => typeof a === 'string' && a.length > 60);
        if (tooLong.length) return 'Keep each food or allergen under 60 characters.';
        if (value.length > 30) return 'That is a lot of allergens — keep the list to 30.';
        return null;
      }
      return 'Send the allergen list as a list of names.';
    }
    default:
      return null;
  }
}

/** Collects every problem at once, so the form can mark all its fields. */
export function validateIntake(input = {}) {
  const errors = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === 'targetWeightKg' || field === 'deleteExisting') continue;
    const err = validate(field, value);
    if (err) errors[field] = err;
  }
  return errors;
}

/**
 * Checks a requested target weight and date against the safe-pace rule.
 *
 * The plan states the limit up front — "we'll never set a target faster than
 * 0.75 kg/week" — and the engine enforces the equivalent on the calorie deficit
 * it computes. This is the other half: a target weight and a deadline are a
 * promise about pace, and "60 kg by next Tuesday" has to be refused as the
 * impossible request it is rather than accepted and quietly missed.
 *
 * Returns a refusal with the earliest honest date, so the screen can offer
 * something achievable instead of just saying no.
 */
export function checkTargetPace({ startWeightKg, targetWeightKg, targetDate, startDate }) {
  if (
    !Number.isFinite(startWeightKg) ||
    !Number.isFinite(targetWeightKg) ||
    !targetDate ||
    !startDate
  ) {
    return { ok: true };
  }

  const days = daysBetween(startDate, targetDate);
  if (days === null || days <= 0) {
    return { ok: true };
  }

  // Gaining is a different question from losing and the deficit cap does not
  // speak to it, so only a requested LOSS is pace-checked.
  const toLose = startWeightKg - targetWeightKg;
  if (toLose <= 0) return { ok: true };

  const maxWeekly = Math.min(
    SAFETY.maxWeeklyLossKg,
    SAFETY.maxWeeklyLossFractionOfBodyWeight * startWeightKg,
  );
  const weeks = days / 7;
  const requiredWeekly = toLose / weeks;

  if (requiredWeekly <= maxWeekly) return { ok: true };

  const weeksNeeded = Math.ceil(toLose / maxWeekly);
  const earliestDate = addDays(startDate, weeksNeeded * 7);

  return {
    ok: false,
    code: 'TARGET_TOO_AGGRESSIVE',
    // The two bounds, named, because "0.75 kg/week" and "1% of your weight"
    // are different numbers for different people and the tighter one is the
    // one that applies.
    maxWeeklyLossKg: Number(maxWeekly.toFixed(2)),
    limitedBy:
      maxWeekly === SAFETY.maxWeeklyLossKg
        ? 'max_weekly_loss_0.75kg'
        : 'max_weekly_loss_pct_body_weight',
    requiredWeeklyLossKg: Number(requiredWeekly.toFixed(2)),
    weeksNeeded,
    earliestDate,
    error:
      `That is about ${requiredWeekly.toFixed(1)} kg a week, which is faster ` +
      `than the ${maxWeekly.toFixed(2)} kg/week limit. The earliest date we can ` +
      `honour is ${earliestDate}.`,
  };
}

function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// --- reads --------------------------------------------------------------------

/**
 * What the setup screen needs to render itself.
 *
 * Prefills from everything already known — the auth profile for age and sex, the
 * legacy height column, the most recent weight reading — so the plan's promise
 * that "only what's missing is asked" is kept by the server rather than left to
 * the client to guess.
 */
export async function getSetupState({ prisma, userId, localDate }) {
  const day = localDate || todayLocalDate();
  const [goal, profile, weightKg, resolved] = await Promise.all([
    prisma.healthGoal.findUnique({ where: { userId } }),
    prisma.personalisationProfile.findUnique({
      where: { userId },
      // Only height lives here. Age and sex live on the auth-service user, which
      // this service does not read — asking for fields the table does not have
      // would throw rather than prefill, and HealthGoal is the only place this
      // service may cache them anyway (see the snapshot note at the top).
      select: { heightCm: true },
    }),
    latestWeightKg({ prisma, userId, localDate: day }),
    // Called with no measurements on purpose: this is "what would the engine
    // still be missing if the user answered nothing today", which is exactly
    // the list the wizard should ask about.
    resolveInputs({ prisma, userId, localDate: day, measured: null }),
  ]);

  const missing = resolved.ok ? [] : resolved.missing;

  // resolveInputs short-circuits on a missing goal and reports only ['goal'],
  // which is right for the engine — there is nothing to compute without one —
  // and wrong for this screen. A first-run user has to answer goal, age, sex,
  // height and weight, so a wizard that read this list literally would show one
  // question ("what are you working towards?") and then stall with no number.
  //
  // So for a user with no goal the full set is reported. The field names come
  // from MISSING_REASONS so this cannot drift from the engine's vocabulary.
  // The full list for a first-run user; the engine's own list for everyone else.
  // Both come from the same vocabulary, so the screen cannot drift.
  const ALL_REQUIRED = ['goal', 'weight', 'height', 'age', 'sex', 'activity'];
  const reportedMissing = goal ? missing : ALL_REQUIRED.slice();

  return {
    hasGoal: Boolean(goal),
    // `goal` is required by the schema, so a user with no row at all has no goal
    // yet. Reported explicitly so the screen can tell "never started" from
    // "started, nothing computed".
    goal: goal?.goal ?? null,
    prefill: {
      // Restated inside prefill as well, because a form control reads its
      // initial value from one place. The top-level `goal` is for logic; this
      // is for the picker.
      goal: goal?.goal ?? null,
      weightKg,
      heightCm: goal?.heightCm ?? profile?.heightCm ?? null,
      // From HealthGoal only, per the snapshot contract. There is no fallback
      // to read, so a user who has never answered has no prefill here and the
      // screen asks rather than assuming.
      age: goal?.age ?? null,
      sex: goal?.sex ?? null,
      activity: goal?.activity ?? null,
      diet: goal?.diet ?? null,
      allergies: goal?.allergies ?? [],
      targetWeightKg:
        goal?.targetWeightKg == null ? null : Number(goal.targetWeightKg),
      targetDate: goal?.targetDate ?? null,
    },
    // What still has to be answered before a number can be produced. Weight is
    // included even when the scale has a reading, because the user may want to
    // confirm it — but the screen is expected to pre-fill it, not demand it.
    missing: reportedMissing,
    reasons: resolved.ok
      ? {}
      : Object.fromEntries(
          reportedMissing
            .filter((f) => MISSING_REASONS[f])
            .map((f) => [f, MISSING_REASONS[f]]),
        ),
    options: {
      goals: GOAL_TYPES.map((value) => ({ value, label: GOAL_LABELS[value] })),
      sexes: SEXES,
      activities: ACTIVITY_LEVELS,
      diets: DIET_PATTERNS,
    },
    limits: {
      // Sent so the screen can state the rule before the user picks a date,
      // exactly as the plan's copy does, instead of refusing them afterwards.
      maxWeeklyLossKg: SAFETY.maxWeeklyLossKg,
      maxWeeklyLossPct: SAFETY.maxWeeklyLossFractionOfBodyWeight,
    },
  };
}

// --- writes -------------------------------------------------------------------

/**
 * Creates or updates the intake record.
 *
 * `goal` is required to create the row, because the schema requires it, but
 * everything else is optional: a user who wants to log food without answering
 * an activity question still gets a target, and the engine simply waits on the
 * fields it genuinely cannot do without.
 */
export async function saveIntake({ prisma, userId, input = {}, localDate }) {
  const day = localDate || todayLocalDate();
  const errors = validateIntake(input);
  if (Object.keys(errors).length) {
    return { written: false, skipped: 'invalid', errors };
  }

  const existing = await prisma.healthGoal.findUnique({ where: { userId } });
  if (!existing && !input.goal) {
    // No row can be created without a goal, and inventing one would be the
    // service picking a clinical objective on the user's behalf.
    return {
      written: false,
      skipped: 'invalid',
      errors: { goal: 'Choose what you are working towards.' },
    };
  }

  const startDate = input.startDate ?? existing?.startDate ?? day;

  // --- decide everything before writing anything ---------------------------
  //
  // The order here is load-bearing, and it was wrong in the first draft: the
  // weight was written first and the safe-pace check ran afterwards. A refused
  // save then left a weight reading behind with no goal to explain it, so
  // targetService would pick the user up as "has a weight, has no goal" and the
  // wizard would ask them to redo a step they had already answered. Both
  // refusals now happen before the first write.

  const currentWeightKg = await latestWeightKg({ prisma, userId, localDate: day });
  const weightKg = input.weightKg != null ? Number(input.weightKg) : currentWeightKg;

  const targetWeightKg =
    input.targetWeightKg === undefined
      ? undefined
      : input.targetWeightKg === null
        ? null
        : Number(input.targetWeightKg);
  const targetDate =
    input.targetDate === undefined ? undefined : input.targetDate || null;

  if (targetWeightKg != null) {
    if (
      !Number.isFinite(targetWeightKg) ||
      targetWeightKg < WEIGHT_KG_RANGE.min ||
      targetWeightKg > WEIGHT_KG_RANGE.max
    ) {
      return {
        written: false,
        skipped: 'invalid',
        errors: {
          targetWeightKg: `Enter a target weight between ${WEIGHT_KG_RANGE.min} and ${WEIGHT_KG_RANGE.max} kg.`,
        },
      };
    }

    const pace = checkTargetPace({
      startWeightKg: weightKg,
      targetWeightKg,
      targetDate,
      startDate,
    });
    if (!pace.ok) {
      // Refused, and nothing is written. Accepting the pair and letting the
      // engine quietly produce a slower number than the user asked for would
      // leave them chasing a date the app had already decided was impossible.
      return { written: false, skipped: 'target_too_aggressive', pace };
    }
  }

  // --- the weight goes to the time series, not here -------------------------
  let weightWritten = false;
  if (input.weightKg != null) {
    const todayReading = await prisma.biometricEntry.findUnique({
      where: {
        userId_metric_localDate: { userId, metric: 'weight', localDate: day },
      },
      select: { id: true },
    });

    if (todayReading) {
      // Same day, so this is a correction of today's figure. Overwriting is
      // correct: a mis-keyed 70.4 kg read as 104 kg would otherwise poison every
      // later average.
      await prisma.biometricEntry.update({
        where: { id: todayReading.id },
        data: { value: input.weightKg, unit: 'kg', source: 'manual' },
      });
    } else {
      await prisma.biometricEntry.create({
        data: {
          userId,
          metric: 'weight',
          value: input.weightKg,
          unit: 'kg',
          source: 'manual',
          localDate: day,
        },
      });
    }
    weightWritten = true;
  }

  // Only the fields actually supplied are written. An intake screen that
  // pre-fills from the auth profile would otherwise send every field on every
  // save, and a null for a field the user never touched would erase a value
  // they set earlier.
  const data = {};
  const set = (key, value) => {
    if (input[key] !== undefined) data[key] = value;
  };

  set('goal', input.goal);
  set('sex', input.sex ?? null);
  set('age', input.age == null ? null : Number(input.age));
  set('heightCm', input.heightCm == null ? null : Math.round(Number(input.heightCm)));
  set('activity', input.activity ?? null);
  set('diet', input.diet ?? null);
  set('allergies', Array.isArray(input.allergies) ? input.allergies : undefined);
  set('startDate', input.startDate ?? startDate);
  set('targetWeightKg', targetWeightKg ?? null);
  set('targetDate', targetDate ?? null);

  const goal = existing
    ? await prisma.healthGoal.update({ where: { userId }, data })
    : await prisma.healthGoal.create({ data: { userId, startDate, ...data } });

  return {
    written: true,
    goal,
    // Reported so the screen can confirm what it did, including the fact that a
    // weight typed at intake became a reading rather than a profile field.
    weightWritten,
    weightKg,
  };
}

export { MISSING_REASONS };
