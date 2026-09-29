import {
  ACTIVITY_FACTORS,
  FAT_FRACTION,
  FIBRE_G_PER_1000_KCAL,
  GOAL_KCAL_ADJUSTMENT,
  PROTEIN_PER_KG,
  SAFETY,
  WATER_ML_PER_KG,
  WATER_ML_WORKOUT_ADDEND,
  microAllowances,
  roundTo,
} from './constants.js';

// Mifflin-St Jeor. The equation chosen over Harris-Benedict because it was
// derived on a wider age range and is the formula the sports-nutrition
// literature actually uses for people who train, which is this app's user.
//
// It needs height, weight, age and sex. A user who skipped any of them gets
// NO calorie target rather than a guessed one — see resolveInputs, which is
// the honest version of "we need this before we can tell you a number".
export function bmr({ weightKg, heightCm, age, sex }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'female' ? base - 161 : base + 5;
}

// The goal adjustment, constrained by the kg/week cap.
//
// The cap is the interesting part. A fat-loss goal of -500 kcal is fine for
// most adults and reckless for a 45 kg woman — it works out to more than 1%
// of body weight a week, which is the threshold the plan states it will never
// cross. So the deficit is capped as a fraction of body weight and the
// shortfall is reported in `inputs.clampedFrom`, which is what lets the
// targets screen say "we asked for 400 and gave you 300 because 400 would be
// faster than is safe" instead of quietly returning a different number than
// the formula's nominal output.
// The largest daily deficit this engine will ask anyone to run, and which of
// the two rules set it.
//
// Exported on its own because it is the safety function: it is worth testing
// directly at every weight, rather than only through a goal that happens to ask
// for more than the answer. The nominal adjustment is -400 kcal, so for any
// adult above ~36 kg neither bound binds and this value is not exercised at all
// by the goal path — which is precisely why the old formula could be wrong at
// 200 kg without a test noticing.
export function maxDeficitKcal(weightKg) {
  const absolute = (SAFETY.maxWeeklyLossKg * 7700) / 7;
  const proportional =
    (SAFETY.maxWeeklyLossFractionOfBodyWeight * weightKg * 7700) / 7;
  return {
    value: Math.min(absolute, proportional),
    // Tie goes to the proportional bound, because that is the one describing
    // this specific user's scale rather than a universal ceiling. Reporting the
    // tighter of two equal numbers as the looser would be the more confusing
    // of the two claims.
    rule:
      proportional <= absolute
        ? 'max_weekly_loss_pct_body_weight'
        : 'max_weekly_loss_0.75kg',
  };
}

// Returns the adjustment to apply, the one the formula asked for, and which
// bound (if any) reduced it.
export function goalAdjustmentKcal(goal, weightKg) {
  const [min, max] = GOAL_KCAL_ADJUSTMENT[goal] || [0, 0];
  let value = Math.round((min + max) / 2);
  let clampedBy = null;

  if (min < 0) {
    const requested = Math.abs(value);
    const { value: maxDeficit, rule } = maxDeficitKcal(weightKg);
    if (requested > maxDeficit) {
      value = -Math.round(maxDeficit);
      clampedBy = rule;
    }
  }

  return { value, requested: Math.round((min + max) / 2), clampedBy };
}

// Validates and normalises the inputs, returning null-safe values plus the
// list of what is missing.
//
// Missing height/age/sex is a hard stop for the calorie chain but NOT for the
// plan: someone who declined to give their height can still get a plan with
// doctor items ticked and workouts logged, which is most of the score. A
// health feature that refuses to work at all because one intake field was
// skipped is a health feature that gets deleted.
export function resolveInputs({ weightKg, heightCm, age, sex, activity, hasWorkoutToday }) {
  const missing = [];
  const w = Number(weightKg);
  const h = Number(heightCm);
  const a = Number(age);

  if (!Number.isFinite(w) || w <= 0) missing.push('weight');
  if (!Number.isFinite(h) || h <= 20) missing.push('height');
  if (!Number.isFinite(a) || a <= 12 || a > 100) missing.push('age');
  if (!['male', 'female', 'other'].includes(sex)) missing.push('sex');
  if (!ACTIVITY_FACTORS[activity]) missing.push('activity');

  return {
    ok: missing.length === 0,
    missing,
    weightKg: Number.isFinite(w) && w > 0 ? w : null,
    heightCm: Number.isFinite(h) && h > 20 ? h : null,
    age: Number.isFinite(a) && a > 12 && a <= 100 ? a : null,
    sex: ['male', 'female', 'other'].includes(sex) ? sex : null,
    activity: ACTIVITY_FACTORS[activity] ? activity : null,
    hasWorkoutToday: Boolean(hasWorkoutToday),
  };
}

export function computeTargets(goal, raw) {
  const i = resolveInputs(raw);

  if (!i.ok) {
    // Not an error. The caller stores nothing and the app shows a plan with
    // an empty targets block plus whatever it CAN do, which is the behaviour
    // the intake screen promises when it says "only what's missing is asked".
    return {
      ok: false,
      missing: i.missing,
      targets: null,
      inputs: { missing: i.missing },
    };
  }

  const resting = bmr({
    weightKg: i.weightKg,
    heightCm: i.heightCm,
    age: i.age,
    sex: i.sex,
  });
  const factor = ACTIVITY_FACTORS[i.activity];
  const maintenance = resting * factor;
  const adjustment = goalAdjustmentKcal(goal, i.weightKg);

  let kcal = Math.round(maintenance + adjustment.value);

  // --- The eating-disorder guard, applied before anything else sees kcal ---
  //
  // Three floors, in order of specificity, all of them non-negotiable:
  //   1. never below BMR
  //   2. never below the absolute floor for the user's sex
  //   3. never below the same floor for a 45 kg person of that sex, so a very
  //      light user is not handed a 900 kcal target by arithmetic that is
  //      technically correct and practically dangerous
  const floorBySex =
    i.sex === 'male'
      ? SAFETY.kcalFloorMale
      : i.sex === 'female'
        ? SAFETY.kcalFloorFemale
        : SAFETY.kcalFloorOther;
  const effectiveFloor = Math.max(Math.round(resting), floorBySex);
  let floored = false;
  if (kcal < effectiveFloor) {
    kcal = effectiveFloor;
    floored = true;
  }

  // Protein next, because it is the number that matters most and it should
  // not be scaled off a kcal figure we just clamped.
  const [pMin, pMax] = PROTEIN_PER_KG[goal] || PROTEIN_PER_KG.general_health;
  const proteinPerKg = (pMin + pMax) / 2;
  const proteinG = Math.round(proteinPerKg * i.weightKg);

  // Fat as a fraction, clamped so a large protein target cannot push fat
  // below the level hormones need.
  const fatFraction = Math.min(
    Math.max((FAT_FRACTION.min + FAT_FRACTION.max) / 2, FAT_FRACTION.min),
    FAT_FRACTION.max,
  );
  let fatG = Math.round((kcal * fatFraction) / 9);

  // Carbs take what is left, and can go to zero. A high-protein, low-carb
  // target is a legitimate outcome for someone who asked for recomposition,
  // and the plan's own worked example lands around 300 g rather than a
  // number derived from a minimum.
  let carbsG = Math.round((kcal - proteinG * 4 - fatG * 9) / 4);
  if (carbsG < 0) {
    // Protein + fat already exceed the calories. Give the surplus back to
    // carbs rather than printing a negative number or silently dropping
    // protein, which would make the headline protein target a lie.
    carbsG = 0;
    const overshoot = proteinG * 4 + fatG * 9 - kcal;
    fatG = Math.max(0, Math.round(((fatG * 9 - overshoot) / 9)));
  }

  const fibreG = Math.round((kcal / 1000) * FIBRE_G_PER_1000_KCAL);
  // Split out rather than inlined into waterMl, because the addend is the one
  // part of the water target that changes day to day. "Why is my water target
  // higher today?" is a question users ask, and it cannot be answered from a
  // single total.
  const waterAddend = i.hasWorkoutToday ? WATER_ML_WORKOUT_ADDEND : 0;
  const waterMl = i.weightKg * WATER_ML_PER_KG + waterAddend;

  return {
    ok: true,
    missing: [],
    targets: {
      kcal,
      proteinG,
      carbsG,
      fatG,
      fibreG,
      waterMl: Math.round(waterMl),
      micros: microAllowances(i.sex, i.age),
    },
    // Stored on the row so "Why these numbers?" never has to re-derive
    // anything. Everything the client needs to write one sentence of
    // explanation is in here.
    inputs: {
      weightKg: round2(i.weightKg),
      heightCm: i.heightCm,
      age: i.age,
      sex: i.sex,
      activity: i.activity,
      activityFactor: factor,
      bmrKcal: Math.round(resting),
      maintenanceKcal: Math.round(maintenance),
      goalAdjustmentKcal: adjustment.value,
      goalAdjustmentRequestedKcal: adjustment.requested,
      // Present only when one of the loss bounds bound. Absent means the
      // requested adjustment was used as-is, which is the normal case.
      // `clampedBy` names the bound that actually applied, because "we asked
      // for 400 and gave you 400-something" is not the same message as "we gave
      // you 300 because 0.75 kg/week is your absolute ceiling" and a user
      // reading one when the other applied has been told something false.
      ...(adjustment.value !== adjustment.requested
        ? {
            clampedFromKcal: adjustment.requested,
            clampedBy: adjustment.clampedBy,
          }
        : {}),
      ...(floored
        ? {
            kcalFloorApplied: effectiveFloor,
            kcalFloorReason: Math.round(resting) > floorBySex ? 'bmr' : 'absolute_floor',
          }
        : {}),
      proteinPerKg: round2(proteinPerKg),
      proteinPerKgRange: [pMin, pMax],
      fatFraction: round2(fatFraction),
      waterBaseMl: Math.round(i.weightKg * WATER_ML_PER_KG),
      waterAddend,
      hasWorkoutToday: i.hasWorkoutToday,
    },
  };
}

// Derives which activity band real logged data supports, for the switch from
// guessed to measured at 14 days.
//
// Kept as a separate exported function rather than folded into computeTargets
// because it needs a history query and therefore belongs to the service, not
// the pure engine. The pure engine takes a band; deciding which band is the
// service's job.
export function bandForMeasuredBurn(avgActiveKcal, avgSessionsPerWeek) {
  if (!Number.isFinite(avgActiveKcal) || avgActiveKcal < 0) return null;
  const sessions = Number.isFinite(avgSessionsPerWeek) ? avgSessionsPerWeek : 0;

  // Bands keyed on daily active burn, which is what the factor actually
  // multiplies.
  //
  // Session count is a TIEBREAKER and only inside the moderate band, so
  // someone who trains five times a week but burns 500 active calories is read
  // as "very active" while someone who logs six very short sessions is not.
  //
  // It used to be an unconditional `|| sessions >= 6`, which meant frequency
  // could override any amount of burn — 10 kcal/day of active burn across six
  // sessions a week classified as "very active", raising the multiplier on a
  // target that was then wildly too high. The count is now consulted only
  // where the burn is already in the neighbouring band.
  if (avgActiveKcal >= 750) return 'very_active';
  if (avgActiveKcal >= 400) return sessions >= 5 ? 'very_active' : 'moderate';
  if (avgActiveKcal >= 180) return 'light';
  return 'sedentary';
}

// Rounding lives in constants.js so the target maths, the nutrition totals and
// the stored snapshots all round identically. See roundTo there for why the
// epsilon nudge matters.
function round2(n) {
  return roundTo(n, 2);
}
