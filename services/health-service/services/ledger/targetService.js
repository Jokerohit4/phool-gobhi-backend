// Resolving the body inputs a target calculation needs, apart from the
// calculation itself.
//
// This is separated from targetEngine.js because it is the only part that
// touches the database, and the part where the interesting decisions live.
//
// The decisions, and why they are decisions rather than plumbing:
//
//   WEIGHT COMES FROM A TIME SERIES, NEVER FROM A SETUP COPY.
//   BiometricEntry(metric='weight') is the single source of truth. The schema
//   says so in a comment on PersonalisationProfile, and it is the right call:
//   a stored "setup weight" goes stale the moment the user loses weight, and a
//   target recomputed against a body that no longer exists is worse than no
//   target. If a user has logged a weight, that is the weight. If they have
//   not, the honest answer is "missing: ['weight']" — not a guess, and not
//   last-known-from-somewhere-else.
//
//   HEIGHT IS CACHED, WITH A FALLBACK TO THE PLACEHOLDER.
//   heightCm lives on HealthGoal from intake. PersonalisationProfile.heightCm
//   predates this feature and is documented in its own comment as "a
//   deliberate placeholder, not the long-term home". So the fallback reads it
//   rather than leaving existing users with no height and making them re-enter
//   something they already told us.
//
//   NOTHING IS BACKFILLED INTO A TARGET.
//   A recompute that cannot resolve its inputs returns the missing list and
//   leaves the existing NutritionTarget row exactly as it was. Overwriting a
//   target the user is currently following with "insufficient data" would be
//   the number moving under them, which is the failure this whole feature is
//   designed to avoid.

import { computeTargets, bandForMeasuredBurn } from './targetEngine.js';
import {
  MEASURED_ACTIVITY_THRESHOLD_DAYS,
  MIN_USABLE_MEASURED_BURN_KCAL,
  SAFETY,
} from './constants.js';

export const MISSING_REASONS = {
  weight: 'weight_not_logged',
  height: 'height_unknown',
  age: 'age_unknown',
  sex: 'sex_unknown',
  activity: 'activity_unknown',
  goal: 'goal_not_set',
};

/**
 * Reads the latest weight reading for a user, in the user's own calendar.
 *
 * @param {object} deps - { prisma, userId, localDate }
 * @returns {Promise<number|null>} kg, or null when nothing has been logged
 */
export async function latestWeightKg({ prisma, userId, localDate }) {
  const reading = await prisma.biometricEntry.findFirst({
    where: { userId, metric: 'weight' },
    // Same-calendar-day first, so a user who weighs in this morning recomputes
    // against this morning. Falls back to the most recent earlier reading.
    orderBy: [{ localDate: 'desc' }, { id: 'desc' }],
  });

  if (!reading) return null;

  // A reading dated in the future is a clock skew or a typo, not a body
  // measurement. Ignoring it is better than inflating someone's BMR.
  if (localDate && reading.localDate > localDate) return null;

  const kg = Number(reading.value);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  // Below 25 kg or above 400 kg is not a human. Refuse rather than compute a
  // target that would look plausible and be meaningless.
  if (kg < 25 || kg > 400) return null;
  return kg;
}

/**
 * Decides whether measured activity may supersede the user's own guess.
 *
 * The plan's rule is 14 days of data. Before that the user's stated activity
 * stands, because a week of three logged walks is not evidence that someone
 * is "very active" and telling them to stop would be the service guessing.
 */
export function resolveActivity({ goal, measuredBurnKcal, measuredDays, todayBurnKcal }) {
  if (measuredDays < MEASURED_ACTIVITY_THRESHOLD_DAYS) {
    return { activity: goal?.activity ?? null, isMeasured: false, band: null };
  }

  // A long window that recorded almost no active burn is a device that was not
  // worn, not a sedentary life. Treating it as measured would lower the
  // activity factor and cut the user's calorie target on the strength of a
  // watch in a drawer, so below the floor the user's own answer stands.
  const usable =
    Number.isFinite(measuredBurnKcal) && measuredBurnKcal >= MIN_USABLE_MEASURED_BURN_KCAL;
  if (!usable) {
    return {
      activity: goal?.activity ?? null,
      isMeasured: false,
      band: null,
      ignoredBecause: 'measured_burn_below_floor',
    };
  }

  const band = bandForMeasuredBurn(measuredBurnKcal, measuredDays);
  return {
    activity: band ?? goal?.activity ?? null,
    isMeasured: Boolean(band),
    band,
  };
}

/**
 * Resolves every input a target needs, or reports exactly which are missing.
 *
 * Returns `{ ok: false, missing, reasons }` rather than throwing: the intake
 * screen needs the full list at once to ask for all of it in one pass, and a
 * thrown error would surface as a 500 with no actionable content.
 */
export async function resolveInputs({ prisma, userId, localDate, measured }) {
  const goal = await prisma.healthGoal.findUnique({ where: { userId } });

  if (!goal || !goal.goal) {
    return { ok: false, goal: null, missing: ['goal'], reasons: { goal: MISSING_REASONS.goal } };
  }

  // Height: the cached intake value on HealthGoal, falling back to the older
  // PersonalisationProfile placeholder. Both are read because users who set up
  // the existing health-metrics feature answered this already, and being asked
  // again for a fact they gave is how intakes get abandoned.
  let heightCm = goal.heightCm ?? null;
  let heightSource = 'intake';
  if (heightCm === null) {
    const profile = await prisma.personalisationProfile.findUnique({
      where: { userId },
      select: { heightCm: true },
    });
    if (profile?.heightCm != null) {
      heightCm = profile.heightCm;
      heightSource = 'legacy_profile';
    }
  }

  const weightKg = await latestWeightKg({ prisma, userId, localDate });
  const activity = resolveActivity({
    goal,
    measuredBurnKcal: measured?.dailyBurnKcal ?? null,
    measuredDays: measured?.days ?? 0,
    todayBurnKcal: measured?.todayBurnKcal ?? null,
  });

  const candidate = {
    weightKg,
    heightCm,
    // Age is a snapshot by design. See the note on HealthGoal.age.
    age: goal.age ?? null,
    sex: goal.sex ?? null,
    activity: activity.activity,
    hasWorkoutToday: measured?.hasWorkoutToday ?? false,
  };
  const missing = [];
  if (candidate.weightKg === null) missing.push('weight');
  if (candidate.heightCm === null) missing.push('height');
  if (candidate.age === null) missing.push('age');
  if (candidate.sex === null) missing.push('sex');
  if (candidate.activity === null) missing.push('activity');

  if (missing.length) {
    const reasons = {};
    for (const field of missing) {
      reasons[field] =
        field === 'weight' ? MISSING_REASONS.weight : MISSING_REASONS[field];
    }
    return { ok: false, goal, missing, reasons, activity, heightSource };
  }

  return { ok: true, goal, inputs: candidate, activity, heightSource };
}

/**
 * Recomputes a user's nutrition targets from stored inputs.
 *
 * Refuses to overwrite a `user_edited` target — see NutritionTarget.source.
 * Returns `{ written: false, skipped: 'user_edited' }` in that case rather than
 * clobbering a number the user chose and is currently following.
 */
export async function recomputeTargets({ prisma, userId, localDate, measured, rulesVersion }) {
  const resolved = await resolveInputs({ prisma, userId, localDate, measured });
  if (!resolved.ok) {
    return { written: false, skipped: 'missing_inputs', missing: resolved.missing, reasons: resolved.reasons };
  }

  const existing = await prisma.nutritionTarget.findFirst({
    where: { userId, goal: resolved.goal.goal },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (existing && existing.source === 'user_edited') {
    return { written: false, skipped: 'user_edited', targetId: existing.id };
  }

  const computed = computeTargets(resolved.goal.goal, resolved.inputs);
  if (!computed.ok) {
    // Belt and braces: resolveInputs already checked, but the engine also
    // range-checks (an age of 8 is present but not usable) and its list is the
    // one the intake screen should show.
    return { written: false, skipped: 'invalid_inputs', missing: computed.missing };
  }

  const target = await prisma.nutritionTarget.create({
    data: {
      userId,
      goal: resolved.goal.goal,
      effectiveFrom: localDate,
      source: 'formula',
      rulesVersion: rulesVersion || 'v1',
      kcal: computed.targets.kcal,
      proteinG: computed.targets.proteinG,
      carbsG: computed.targets.carbsG,
      fatG: computed.targets.fatG,
      fibreG: computed.targets.fibreG,
      waterMl: computed.targets.waterMl,
      // The whole point of the inputs column: "Why these numbers?" reads this
      // and never re-derives, so a retune of the formula cannot retroactively
      // change the explanation a user was given last month.
      inputs: computed.inputs,
      micros: computed.targets.micros,
    },
  });

  return {
    written: true,
    target,
    targets: computed.targets,
    inputs: computed.inputs,
    // Whether measured activity or the user's own guess produced the numbers,
    // so the targets screen can say which.
    activityIsMeasured: resolved.activity.isMeasured,
  };
}

export { SAFETY };
