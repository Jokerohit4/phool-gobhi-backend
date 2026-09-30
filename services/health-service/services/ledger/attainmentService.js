// Whether the goal is actually being met - reported SEPARATELY from the score.
//
// The distinction this file exists to protect: the score measures inputs (what
// you did today), attainment measures the outcome (whether the thing you set out
// to do happened). Those are different questions with different evidence, and
// collapsing them is how a tracker ends up telling someone they succeeded when
// all it can see is that they were busy.
//
// Four decisions worth stating up front, because each is a place where the
// honest answer is less flattering than the easy one:
//
//   THE SCORE IS NEVER A SUBSTITUTE FOR A MEASUREMENT.
//   A rising score with no weight logged does not imply progress. It means the
//   inputs were ticked. With no reading there is nothing to compare, and the
//   answer is "not measured yet" - not a proxy, not a trend, not a guess. The
//   temptation to fall back to the score is exactly the conflation this feature
//   was built to avoid, so no code path here does it.
//
//   A PASSED TARGET DATE IS REPORTED, NOT FAILED.
//   The user set a date. It has gone. The honest thing is to say what the gap is
//   and let them set a new target, because "you failed" is not information anyone
//   can act on and a permanently-red card is a card people stop reading. There is
//   no `failed` status anywhere in this file, and that is a decision rather than
//   an oversight.
//
//   ATTAINMENT IS ABOUT THE OUTCOME, THE SCORE ABOUT THE DAY.
//   Nothing here reads a score, a streak, a point total or a plan item. A user
//   who trains perfectly and does not move has not attained the goal, and this
//   file is the one that has to be able to say so.
//
//   "ON TRACK" IS A PROJECTION, AND IS LABELLED AS ONE.
//   It is the user's own weight trend extended to their own deadline. A real
//   projection of a real person's body, and it is only ever offered alongside the
//   required rate it is being compared against, so the number that would prove it
//   wrong is on screen too.

/** Why an attainment answer is the shape it is. Drives the screen's wording. */
export const ATTAINMENT_STATUS = {
  /** No target weight set, so there is nothing to be at or short of. */
  NO_TARGET: 'no_target',
  /** A target exists but no weight has ever been logged, so nothing to compare. */
  NOT_MEASURED: 'not_measured',
  /** Target met, to within [REACHED_TOLERANCE_KG] or already past it. */
  REACHED: 'reached',
  /** The date has passed and the target was not met. Reported, not failed. */
  DATE_PASSED: 'date_passed',
  /** Still before the date, and the trend projects inside the tolerance. */
  ON_TRACK: 'on_track',
  /** Still before the date, and the trend does not. */
  BEHIND_PACE: 'behind_pace',
  /** A target with no date, and it has not been reached. */
  NOT_REACHED: 'not_reached',
};

/**
 * How stale a weight reading may be before the answer stops being trusted.
 *
 * Three weeks. Long enough that nobody is nagged for missing a weigh-in, short
 * enough that a number three weeks old is not presented as if it were this
 * morning. Past this the status still answers, but `stale` is set so the screen
 * can say the reading is old rather than implying a currency it does not have.
 */
export const STALE_WEIGHT_DAYS = 21;

/**
 * How far from the target still counts as having reached it, in kg.
 *
 * It exists because weight moves for reasons that have nothing to do with the
 * plan - water, salt, a late meal, the scale being a different scale - and
 * declaring "you reached your goal" to someone 0.3 kg short would be a claim
 * this data cannot support. The alternative, the one a naive implementation
 * picks, is to make a person's success depend on the precision of their bathroom
 * scale.
 *
 * Applied symmetrically to gains, so a bulk is not "achieved" by overshooting it
 * by half a kilo.
 */
export const REACHED_TOLERANCE_KG = 0.5;

/**
 * How far back a "since you started" baseline may reach.
 *
 * A year. Past that the first reading describes a different baseline rather than
 * the user's current situation, and progress measured from it is arithmetic
 * dressed up as insight.
 */
const BASELINE_MAX_AGE_DAYS = 365;

/**
 * The weight range this service will treat as a body.
 *
 * Deliberately the same bounds as `METRIC_BOUNDS.weight` in biometricService.js,
 * restated rather than imported: that module opens a PrismaClient on import, and
 * pulling it in here would give a pure arithmetic file a database connection. If
 * the two ever disagree, that module is the authority and this is the copy that
 * should change.
 *
 * It matters more here than the bounds suggest. A typo of 3 kg would otherwise be
 * read as the user's current weight and reported as "behind pace" against any
 * normal target, with a rate derived from it - a whole confident answer built on a
 * mistyped number.
 */
const WEIGHT_BOUNDS_KG = [20, 400];

/**
 * Whether a reading is a plausible body weight.
 *
 * The `unit` column is deliberately not consulted, and that is a decision rather
 * than an oversight. Every write to this table goes through `upsertEntryService`,
 * which overwrites `unit` with the canonical unit for the metric and rejects a
 * client that sends anything else (`validateUnit`) - so a stored weight row is
 * kilograms by construction, and `targetService.latestWeightKg` reads it the same
 * way. Converting again here would be the second conversion of a value that was
 * never converted, and the first thing to break if a unit change ever landed.
 */
function isUsableWeight(kg) {
  return Number.isFinite(kg) && kg >= WEIGHT_BOUNDS_KG[0] && kg <= WEIGHT_BOUNDS_KG[1];
}

/** Days between two local-date strings, or null if either is unparseable. */
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * The user's weight series, cleaned.
 *
 * Future-dated and non-physical readings are dropped rather than clamped. A
 * reading dated ahead of today is a typo or a clock skew, and letting one through
 * would let a user appear to have hit a goal they have not approached yet; a
 * reading of 400 kg is not a body. Ascending by date, since every comparison
 * below is against a start and an end.
 *
 * The target-date-invalid cases are handled by the caller, which is where the
 * decision about what a bad date means belongs - this function's only job is to
 * return readings that can be compared.
 */
function cleanReadings(readings, today) {
  return (Array.isArray(readings) ? readings : [])
    .filter(
      (r) =>
        r &&
        typeof r.localDate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.localDate) &&
        r.localDate <= today &&
        isUsableWeight(r.kg),
    )
    .slice()
    .sort((a, b) =>
      a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0,
    );
}

/**
 * Where "since you started" begins, absent an explicit start date.
 *
 * The first reading within the baseline window. Read as the user's own earliest
 * usable weigh-in rather than as a fixed number of days ago, because the readings
 * are the evidence and inventing a cutoff that does not line up with them would
 * put an arbitrary start point on someone's progress.
 */
function baselineFrom(readings, today) {
  const cutoff = addDays(today, -BASELINE_MAX_AGE_DAYS);
  const inWindow = readings.filter((r) => r.localDate >= cutoff);
  return (inWindow.length ? inWindow : readings)[0];
}

/**
 * Extrapolates the user's own trend to their own deadline, and states the rate
 * that would actually be needed.
 *
 * Linear, deliberately. Anything smarter is a claim about a person's future that
 * a straight line between their first and last weigh-in does not support, and the
 * error is one-sided: an optimistic curve tells someone they are on track when
 * they are not.
 *
 * `daysLeft <= 0` returns null rather than a negative projection. A date that has
 * already gone says nothing about pace, and dividing by a negative span here
 * manufactures a confident-looking number pointing the wrong way.
 *
 * `now` is a parameter rather than a `new Date()` so the caller owns the clock
 * and the arithmetic is testable.
 *
 * @returns {object|null} null when there is no honest projection to make
 */
export function projectPace({ start, current, target, now, targetDate }) {
  const daysLeft = daysBetween(now, targetDate);
  if (daysLeft === null || daysLeft <= 0) return null;

  const daysElapsed = daysBetween(start.localDate, now);
  // A same-day or future-dated start gives no rate to project from. Reported as
  // "no projection" instead of as a required rate with nothing behind it.
  if (daysElapsed === null || daysElapsed < 1) return null;

  const needed = target - current.kg;
  const remaining = daysBetween(now, targetDate);

  const actualWeekly = ((current.kg - start.kg) / daysElapsed) * 7;
  const requiredWeekly = (needed / remaining) * 7;
  // Where the current trend lands on the target date. This is the number the
  // status is decided by.
  const projected = current.kg + (actualWeekly / 7) * remaining;

  return {
    daysLeft: remaining,
    actualWeeklyKg: round2(actualWeekly),
    requiredWeeklyKg: round2(requiredWeekly),
    projectedTargetKg: round2(projected),
  };
}

/**
 * Whether the trend, carried to the deadline, reaches the target.
 *
 * Deliberately "will I get there" rather than "am I moving fast enough". A user
 * slightly under the required weekly rate who is already close enough to land it
 * is on track; the two tests disagree, and only the first is the question anyone
 * actually cares about.
 *
 * DIRECTION-AWARE, AND THAT IS NOT A DETAIL. The obvious test - "does the
 * projection land within the tolerance of the target" - is wrong, and wrong in the
 * cruelest direction available. Someone losing 0.7 kg a week against a required
 * 0.45 projects to 1.1 kg *past* their target, so the naive test calls them
 * behind pace. They are ahead. A tracker that says "behind" to someone who is
 * comfortably in front is worse than one that says nothing, so what is asked here
 * is whether the trend reaches the target by the deadline, and overshooting counts
 * as reaching it. Someone who will have passed through the target has attained
 * it; the only question that would make an overshoot a problem - do they want to
 * stop - is not one this service can answer on their behalf.
 *
 * The tolerance is still applied on the near side, so a projection that lands just
 * short of the target does not read as a certainty.
 *
 * No projection means no claim. Falling back to the score here would reintroduce
 * the exact conflation this file exists to prevent, so a missing projection reads
 * as "not demonstrably on pace" - the direction that does not tell someone
 * something reassuring we cannot support.
 */
function isOnPace({ pace, target, current }) {
  if (!pace || pace.projectedTargetKg == null) return false;
  const losing = target < current.kg;
  return losing
    ? pace.projectedTargetKg <= target + REACHED_TOLERANCE_KG
    : pace.projectedTargetKg >= target - REACHED_TOLERANCE_KG;
}

/**
 * Whether the user's own series has carried them across the target.
 *
 * `reached` is only asked about the tolerance band, so somebody 3 kg *below* a
 * 75 kg target falls outside it. That is right for "is it within half a kilo" and
 * wrong for "what should this screen say", because the honest answer for them is
 * not that they are short - they have gone past it. The question left open for
 * them is whether to keep going, which is not this service's to answer.
 *
 * PAST MEANS CROSSED, which is the part that matters and the part a
 * sign-comparison gets wrong. Someone going 80 -> 82 against a 75 kg target has
 * not passed it; they have moved away from a number they were never at, and
 * calling that "reached" would congratulate them for overshooting in the wrong
 * direction. So the test is whether the two ends of the series sit on opposite
 * sides of the target, which is the one thing a pair of weigh-ins can actually
 * establish. A single reading cannot, and abstains.
 *
 * Goals that are not about the weight on the scale abstain. `recomp` is the same
 * weight with a different composition, `general_health` and `doctor_plan` may not
 * be weight goals at all, and this service has no composition data - so it must
 * not imply attainment in either direction for them.
 */
const CROSSING_PROVES_NOTHING = new Set([
  'recomp',
  'general_health',
  'doctor_plan',
  'endurance',
]);

function isPastTarget({ target, current, start, goal }) {
  if (goal && CROSSING_PROVES_NOTHING.has(goal)) return false;
  if (!start) return false;
  // Inside the band on both sides is the caller's "reached", and needs no help
  // from here.
  if (Math.abs(target - current.kg) <= REACHED_TOLERANCE_KG) return false;
  // Opposite sides of the target: they have been there, whatever the goal says.
  // Note that a start inside the band counts as being on the target's side of
  // itself, so 75.2 -> 71 is a crossing and not a near-miss - they were there
  // and have gone past.
  return (start.kg - target) * (current.kg - target) < 0;
}

/**
 * Builds the attainment answer. Pure, so every honest case is unit-testable with
 * no database and no clock.
 *
 * Always returns an object and never throws. A screen that cannot render
 * attainment at all is a worse failure than one that renders a day late, so
 * malformed input degrades to the least-committal status rather than an error.
 *
 * @param {object} input
 * @param {number|null} input.targetWeightKg - from HealthGoal, nullable
 * @param {string|null} input.targetDate - 'YYYY-MM-DD', nullable
 * @param {Array<{kg:number, localDate:string}>} input.readings - any order
 * @param {string} input.today - the user's local date, passed in not read here
 * @param {string|null} [input.goal] - HealthGoal.goal, to read direction from
 * @returns {object}
 */
export function computeAttainment({
  targetWeightKg,
  targetDate,
  readings,
  today,
  goal = null,
}) {
  const target =
    targetWeightKg === null || targetWeightKg === undefined
      ? null
      : Number(targetWeightKg);

  const clean = cleanReadings(readings, today);

  // No target is the most common state and the screen shows nothing for it.
  if (target === null || !Number.isFinite(target) || target <= 0) {
    return {
      status: ATTAINMENT_STATUS.NO_TARGET,
      targetWeightKg: null,
      targetDate: targetDate || null,
      currentWeightKg: null,
      startWeightKg: null,
      asOf: null,
      stale: false,
    };
  }

  // A target date the server cannot parse is ignored rather than trusted. Using it
  // anyway would put a made-up deadline in front of the user and, worse, drive the
  // pace maths from it.
  const hasUsableDate =
    typeof targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(targetDate);
  const date = hasUsableDate ? targetDate : null;

  const current = clean.length ? clean[clean.length - 1] : null;

  // The state the user decided on: say so plainly, substitute nothing for the
  // missing measurement.
  if (!current) {
    return {
      status: ATTAINMENT_STATUS.NOT_MEASURED,
      targetWeightKg: round2(target),
      targetDate: date,
      currentWeightKg: null,
      startWeightKg: null,
      asOf: null,
      stale: false,
    };
  }

  const ageDays = daysBetween(current.localDate, today);
  const base = {
    targetWeightKg: round2(target),
    targetDate: date,
    currentWeightKg: round2(current.kg),
    asOf: current.localDate,
    daysSinceMeasurement: ageDays,
    stale: ageDays !== null && ageDays > STALE_WEIGHT_DAYS,
  };

  const gap = round2(target - current.kg);
  const start = baselineFrom(clean, today);
  const withStart = { ...base, startWeightKg: start ? round2(start.kg) : null };

  // Reached wins over everything, including a passed date. Someone who hit the
  // target and then let the date lapse has still attained the goal, and reporting
  // the date instead would be the app pedantically insisting on a deadline the
  // user's body does not consult.
  //
  // Checked before the date, and with the past-target case folded in, so somebody
  // 3 kg the other side of a cut target is not told their deadline slipped.
  if (
    Math.abs(gap) <= REACHED_TOLERANCE_KG ||
    isPastTarget({ target, current, start, goal })
  ) {
    return { ...withStart, status: ATTAINMENT_STATUS.REACHED, gapKg: gap };
  }

  if (date) {
    const daysLeft = daysBetween(today, date);
    if (daysLeft !== null && daysLeft <= 0) {
      // Reported, with the gap and how long it has been gone, so the user can set
      // a new target. There is no `failed` status here to reach for.
      return {
        ...withStart,
        status: ATTAINMENT_STATUS.DATE_PASSED,
        gapKg: gap,
        daysSinceTarget: daysLeft === null ? null : Math.abs(daysLeft),
      };
    }
  }

  // A target with no usable date has no pace, so it is reached or not, and it is
  // already known not to be reached at this point. `not_reached` rather than
  // `behind_pace`, because there is no pace to be behind - a deadline the user
  // never set is not a schedule they are failing, and borrowing the word would
  // import an accusation the data does not support. The screen renders it as a
  // plain gap.
  if (!date) {
    return {
      ...withStart,
      status: ATTAINMENT_STATUS.NOT_REACHED,
      gapKg: gap,
      daysLeft: null,
      actualWeeklyKg: null,
      requiredWeeklyKg: null,
      projectedTargetKg: null,
    };
  }

  const pace = projectPace({ start, current, target, now: today, targetDate: date });

  return {
    ...withStart,
    status: isOnPace({ pace, target, current })
      ? ATTAINMENT_STATUS.ON_TRACK
      : ATTAINMENT_STATUS.BEHIND_PACE,
    gapKg: gap,
    ...(pace || {
      daysLeft: daysBetween(today, date),
      actualWeeklyKg: null,
      requiredWeeklyKg: null,
      projectedTargetKg: null,
    }),
  };
}

/**
 * Reads a user's weight series and answers attainment.
 *
 * The database half, kept apart from the arithmetic so every honest case in
 * [computeAttainment] is testable with no Prisma and no clock.
 *
 * The whole history is read rather than the latest reading plus a start, because
 * "is this trend on pace" is a question about the line and a two-point answer
 * cannot see one. It is one indexed range read on a column that is a row per
 * weigh-in, not per day, and a user who weighs in daily for a year has 365 rows -
 * small enough that paging this would be complexity with no payoff.
 *
 * `localDate` is a parameter rather than read from the clock, for the reason
 * every other ledger route takes the user's day from the request: the boundary
 * between two readings is the user's, not the server's.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {number} deps.userId
 * @param {string} deps.localDate - the user's local date, 'YYYY-MM-DD'
 * @returns {Promise<object>} always an object
 */
export async function getAttainment(prisma, { userId, localDate }) {
  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: { targetWeightKg: true, targetDate: true, goal: true },
  });

  // Nothing to attain toward, so nothing is read. Returning early is not just
  // cheaper: it keeps the weight series out of a response for a user who has not
  // asked a weight question, which is the smallest and least surprising thing to
  // do on a screen that only shows this when there is a target.
  if (!goal || goal.targetWeightKg == null) {
    return computeAttainment({
      targetWeightKg: null,
      targetDate: null,
      readings: [],
      today: localDate,
    });
  }

  const entries = await prisma.biometricEntry.findMany({
    where: { userId, metric: 'weight' },
    orderBy: [{ localDate: 'asc' }, { id: 'asc' }],
    select: { value: true, localDate: true },
  });

  return {
    ...computeAttainment({
      targetWeightKg: Number(goal.targetWeightKg),
      targetDate: goal.targetDate,
      readings: entries.map((e) => ({ kg: Number(e.value), localDate: e.localDate })),
      today: localDate,
      goal: goal.goal ?? null,
    }),
    // The goal itself, because the screen has to name what is being attained.
    // A number labelled "goal" with no goal attached is a question the user has
    // to answer about their own life.
    goal: goal.goal ?? null,
  };
}
