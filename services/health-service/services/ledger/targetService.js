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
  // The vocabulary the screen speaks is the intake's field names, and that field
  // is now `goals` (a set). `resolveInputs` short-circuits on the same name so
  // the engine, the reason map and the wizard all use one word — the previous
  // split, engine saying `goal` and intake saying `goals`, meant a first-run
  // user was reported missing `goals` with no reason code attached to it.
  goals: 'goal_not_set',
  // Retained because the reason code on any target row written before the
  // multi-goal change is still the singular one, and "Why these numbers?" reads
  // it rather than the live intake.
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
 * Counts real training sessions in a window, for the frequency tiebreaker.
 *
 * Only finished, non-rest sessions count. An open session is a session someone
 * started and may have abandoned, and a rest day is a deliberate absence of
 * training — neither is evidence of activity.
 */
async function countSessions({ prisma, userId, from, to }) {
  const sessions = await prisma.workoutSession.findMany({
    where: {
      userId,
      localDate: { gte: from, lte: to },
      endedAt: { not: null },
      type: { not: 'rest' },
    },
    select: { localDate: true },
  });
  return sessions;
}

/**
 * Gathers the measured-activity inputs a target recompute needs.
 *
 * Two different questions are answered here and they are deliberately kept
 * apart, because conflating them is what previously made every long-observed
 * user look "very active":
 *
 *   - `days`  — how many days of the window actually carry a reading. This is
 *               coverage, and it is the only thing the 14-day threshold should
 *               be about. A user who syncs every day for a year and a user who
 *               syncs every day for a fortnight have the same evidence.
 *   - `sessionsPerWeek` — how often they train, normalised to a week regardless
 *               of how long the window is. This is frequency, and it belongs
 *               only in the band tiebreaker.
 *
 * Before this existed, `resolveActivity` passed the day count into
 * `bandForMeasuredBurn`'s `avgSessionsPerWeek` slot, so the longer somebody
 * measured the more intense they were scored. At a moderate 450 kcal/day, every
 * window of 14 days or more returned "very_active", and the activity factor —
 * and therefore the calorie target — was raised on the strength of a calendar
 * artefact.
 *
 * `dailyBurnKcal` averages only over days that carry a reading, matching how
 * the rest of the service treats this table: a day with no row is missing
 * data, not a day of zero activity. Zero-filling would drag the average down
 * and cut someone's target because their watch was off, which the
 * `MIN_USABLE_MEASURED_BURN_KCAL` floor exists to prevent for the opposite
 * reason.
 */
export async function gatherMeasuredActivity({ prisma, userId, localDate, windowDays }) {
  const days = Number.isFinite(windowDays) && windowDays > 0
    ? Math.floor(windowDays)
    : MEASURED_ACTIVITY_THRESHOLD_DAYS;
  const to = localDate;
  const from = shiftLocalDate(localDate, -(days - 1));

  const [rows, sessions] = await Promise.all([
    prisma.dailyActivityMetric.findMany({
      where: { userId, date: { gte: from, lte: to } },
      select: { date: true, activeCalories: true },
    }),
    countSessions({ prisma, userId, from, to }),
  ]);

  const withBurn = rows.filter((r) => Number.isFinite(Number(r.activeCalories)));
  const dailyBurnKcal = withBurn.length
    ? withBurn.reduce((sum, r) => sum + Number(r.activeCalories), 0) / withBurn.length
    : null;

  const today = rows.find((r) => r.date === localDate);

  return {
    // Coverage, not the window length. A 30-day window in which the user
    // connected their watch on 16 days reports 16, and 16 clears the threshold
    // only because 16 days of reading really is 16 days of reading.
    days: rows.length,
    dailyBurnKcal,
    // Frequency, normalised so a 28-day window and a 14-day window describing
    // the same routine produce the same number.
    sessionsPerWeek: days > 0 ? (sessions.length / days) * 7 : 0,
    sessionsInWindow: sessions.length,
    windowDays: days,
    todayBurnKcal: today?.activeCalories != null ? Number(today.activeCalories) : null,
    // Today's own session, not the window average: the water addend asks whether
    // they are training right now, and averaging over a fortnight would answer
    // "probably" on the wrong day.
    hasWorkoutToday: sessions.some((s) => s.localDate === localDate),
  };
}

/** Subtracts whole days from a 'YYYY-MM-DD' string, staying in that format. */
function shiftLocalDate(localDate, deltaDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return localDate;
  const [y, m, d] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Decides whether measured activity may supersede the user's own guess.
 *
 * The plan's rule is 14 days of data. Before that the user's stated activity
 * stands, because a week of three logged walks is not evidence that someone
 * is "very active" and telling them to stop would be the service guessing.
 *
 * [sessionsPerWeek] is passed through separately from [measuredDays] on
 * purpose: the threshold is about coverage, the band tiebreaker is about
 * frequency, and they are different numbers.
 */
export function resolveActivity({
  goal,
  measuredBurnKcal,
  measuredDays,
  sessionsPerWeek,
  todayBurnKcal,
}) {
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

  const band = bandForMeasuredBurn(measuredBurnKcal, sessionsPerWeek);
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

  // An empty array is a missing goal, not a goal set that happens to sum to zero.
  // Checked on length rather than truthiness for the same reason the engine
  // normalises rather than indexing: `[]` is truthy in JavaScript, so a
  // truthiness check here would let a user with no goals through to a target
  // computed from the `|| [0, 0]` fallback.
  if (!goal || !Array.isArray(goal.goals) || goal.goals.length === 0) {
    return { ok: false, goal: null, missing: ['goals'], reasons: { goals: MISSING_REASONS.goals } };
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
    sessionsPerWeek: measured?.sessionsPerWeek ?? 0,
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
  // Gathered here rather than in the controller. The controller never had the
  // data to gather it from, so it passed nothing, `measured` was always
  // undefined, and every recompute silently fell back to the user's own guess
  // with `days: 0` — meaning the measured-activity switch the plan promises
  // after 14 days could never actually fire. A caller that already has the
  // measurements may still pass them, which is what keeps this testable.
  const measuredActivity =
    measured ?? (await gatherMeasuredActivity({ prisma, userId, localDate }));

  const resolved = await resolveInputs({ prisma, userId, localDate, measured: measuredActivity });
  if (!resolved.ok) {
    return { written: false, skipped: 'missing_inputs', missing: resolved.missing, reasons: resolved.reasons };
  }

  const existing = await prisma.nutritionTarget.findFirst({
    // The newest row for this user, whatever goal produced it. Keyed on userId
    // alone rather than (userId, goal) on purpose: the guard below is "do not
    // overwrite a number this person chose", and a number they chose stays
    // chosen even after they change their mind about their goals.
    where: { userId },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (existing && existing.source === 'user_edited') {
    return { written: false, skipped: 'user_edited', targetId: existing.id };
  }

  const computed = computeTargets(resolved.goal.goals, resolved.inputs);
  if (!computed.ok) {
    // Belt and braces: resolveInputs already checked, but the engine also
    // range-checks (an age of 8 is present but not usable) and its list is the
    // one the intake screen should show.
    return { written: false, skipped: 'invalid_inputs', missing: computed.missing };
  }

  const data = {
    // The whole set, not one of them: this row is the record of what the numbers
    // were derived from, and a two-goal target filed under a single goal cannot
    // explain itself later.
    goals: resolved.goal.goals,
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
  };

  // An upsert keyed on (userId, effectiveFrom), not an insert.
  //
  // The table is an append-only history — one row per day per user — but two
  // recomputes on the SAME day must not leave two rows both claiming to be
  // today's target. The unique constraint makes the second one collide on
  // purpose and this updates that day's row instead. A plain create() here
  // threw a primary-key violation on every recompute after the first, which is
  // why the schema carried PRIMARY KEY (userId) while this code created rows.
  const target = await prisma.nutritionTarget.upsert({
    where: { userId_effectiveFrom: { userId, effectiveFrom: localDate } },
    create: { userId, effectiveFrom: localDate, ...data },
    update: data,
  });

  return {
    written: true,
    target,
    targets: computed.targets,
    inputs: computed.inputs,
    // Whether measured activity or the user's own guess produced the numbers,
    // so the targets screen can say which.
    activityIsMeasured: resolved.activity.isMeasured,
    // Why measured activity did not take over, when it didn't. Without this the
    // app cannot distinguish "still gathering data" from "your watch recorded
    // nothing usable", and the two need different words: the first is a
    // countdown, the second is a suggestion to check the device.
    activityDetail: buildActivityDetail({
      activity: resolved.activity,
      statedActivity: resolved.goal.activity,
      measured: measuredActivity,
    }),
  };
}

/**
 * Builds the "why these numbers?" payload, and nothing else.
 *
 * Extracted from recomputeTargets so a read can produce the same shape. The app
 * used to call the recompute endpoint to obtain this, which made a screen load
 * into a write: opening the targets page created a new NutritionTarget row
 * every time, and did it even for a user whose target is hand-edited and must
 * never be overwritten. An explanation is not a side effect, so it gets its own
 * reader.
 *
 * Every field read defensively. `measured` is optional and tests pass
 * deliberately partial objects, so a missing field is reported as unknown
 * rather than treated as zero.
 */
function buildActivityDetail({ activity, statedActivity, measured }) {
  return {
    isMeasured: activity.isMeasured,
    band: activity.band ?? null,
    ignoredBecause: activity.ignoredBecause ?? null,
    // The user's own answer, which is what was actually used. Reported so the
    // screen can say "using what you told us" rather than implying the estimate
    // came from data.
    usedStatedActivity: statedActivity ?? null,
    daysObserved: measured.days ?? null,
    windowDays: measured.windowDays ?? null,
    sessionsPerWeek: Number.isFinite(measured.sessionsPerWeek)
      ? Number(measured.sessionsPerWeek.toFixed(2))
      : null,
    sessionsInWindow: measured.sessionsInWindow ?? null,
    avgDailyActiveKcal: Number.isFinite(measured.dailyBurnKcal)
      ? Math.round(measured.dailyBurnKcal)
      : null,
  };
}

/**
 * Explains what activity the current numbers were built on, without writing
 * anything.
 *
 * Deliberately answers for *any* state, including the two that return early from
 * recomputeTargets:
 *
 *   - `user_edited` — the user typed their own numbers, so nothing will ever be
 *     recomputed for them. Before this existed they got no explanation at all,
 *     which is precisely backwards: the person with the least idea where a
 *     number came from is the one who set it by hand.
 *   - `missing_inputs` — no target exists yet, so "why these numbers?" has no
 *     numbers, but the activity half still says whether a watch is being used.
 *
 * The stated activity is read straight from HealthGoal rather than via
 * resolveInputs, because resolveInputs is a report on whether a target *can* be
 * computed and this is a report on what is known regardless of that answer.
 */
export async function describeActivity({ prisma, userId, localDate, measured, windowDays }) {
  const measuredActivity =
    measured ?? (await gatherMeasuredActivity({ prisma, userId, localDate, windowDays }));

  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: { activity: true },
  });

  const activity = resolveActivity({
    goal: { activity: goal?.activity ?? null },
    measuredBurnKcal: measuredActivity.dailyBurnKcal ?? null,
    measuredDays: measuredActivity.days ?? 0,
    sessionsPerWeek: measuredActivity.sessionsPerWeek ?? 0,
    todayBurnKcal: measuredActivity.todayBurnKcal ?? null,
  });

  return buildActivityDetail({
    activity,
    statedActivity: goal?.activity ?? null,
    measured: measuredActivity,
  });
}

export { SAFETY };
