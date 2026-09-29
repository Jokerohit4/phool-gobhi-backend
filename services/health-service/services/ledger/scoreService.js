// Freezing a day into a ScoreDaySnapshot, and reading the chain back.
//
// A snapshot is written once, at day close, and never recomputed. That is the
// whole contract, and it is what makes the score mean anything: a chart whose
// history can be rewritten by a later retune of the engine, a corrected food
// value, or a changed target is not a record of anything.
//
// The consequence is that `rulesVersion` is stored on the row. A day scored
// under v1 stays v1 forever, even after the formula changes, and "why is this
// Tuesday worth what it is" is answerable from the breakdown that was written
// next to it rather than by re-running today's code.
//
// Two things are deliberately NOT frozen:
//   - calm mode. It is a display preference and lives on the goal, so toggling
//     it cannot change a stored number. See calmMode in the schema.
//   - the low-intake guard. checkForLowIntakeRun reads recent snapshots at
//     read time, because it is a safety check about the user's current state,
//     not a property of any one day.
import { RULES_VERSION, DECIMAL_PLACES, roundTo, MAX_PAUSE_DAYS } from './constants.js';
import { computeDay, checkForLowIntakeRun } from './scoreEngine.js';
import { getDayTotals } from './nutritionService.js';
import { isDueOn } from './ledgerPlanService.js';

/**
 * Compute (but do not store) what a day is worth.
 *
 * Kept separate from `closeDay` so the app can show today's running score
 * without a snapshot row existing for today. Only a closed day gets frozen.
 */
export async function previewDay(prisma, { userId, localDate, today }) {
  const inputs = await gatherDayInputs(prisma, { userId, localDate, today });
  const target = await prisma.nutritionTarget.findUnique({ where: { userId } });
  const previous = await previousClose(prisma, { userId, localDate });
  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: { pausedFrom: true, pausedUntil: true },
  });
  // `targets`, plural, because that is what computeDay destructures. Passing
  // `target` left it null inside the engine, so every nutrition line was
  // silently skipped and a day could only ever be scored on plan completions.
  // The engine tolerates a null target on purpose - someone who has set a plan
  // but not a nutrition target should still get a score - which is precisely
  // why this went unnoticed: it degraded to a working-looking number.
  return computeDay({
    localDate,
    previousClose: previous,
    ...inputs,
    targets: target,
    closed: localDate < today,
    paused: isPausedOn(goal, localDate),
  });
}

/**
 * Close a day: compute it and write the one row that will never change.
 *
 * Idempotent by way of the (userId, localDate) unique. Re-closing a day returns
 * the existing snapshot rather than overwriting it, because the second call is
 * usually a retry from a client that did not see the first response - and
 * silently replacing a frozen day is exactly the failure this design exists to
 * prevent.
 */
export async function closeDay(prisma, { userId, localDate, today }) {
  const existing = await prisma.scoreDaySnapshot.findUnique({
    where: { userId_localDate: { userId, localDate } },
  });
  if (existing) return { ...existing, alreadyClosed: true };

  const inputs = await gatherDayInputs(prisma, { userId, localDate, today });
  const target = await prisma.nutritionTarget.findUnique({ where: { userId } });
  const previous = await previousClose(prisma, { userId, localDate });
  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: { pausedFrom: true, pausedUntil: true },
  });

  const day = computeDay({
    localDate,
    previousClose: previous,
    ...inputs,
    targets: target,
    closed: true,
    paused: isPausedOn(goal, localDate),
  });

  return prisma.scoreDaySnapshot.create({
    data: {
      userId,
      localDate,
      open: day.open,
      high: day.high,
      low: day.low,
      close: day.close,
      breakdown: day.breakdown,
      paused: day.paused === true,
      rulesVersion: day.rulesVersion || RULES_VERSION,
    },
  });
}

/**
 * The chart series, oldest first, for the ledger chart.
 *
 * `calmMode` is returned alongside rather than applied here. The client decides
 * how to paint it, and it must never be able to change a number by asking for a
 * different view - so this function returns the same values either way.
 */
export async function getScoreSeries(prisma, { userId, limit = 90 }) {
  const rows = await prisma.scoreDaySnapshot.findMany({
    where: { userId },
    orderBy: { localDate: 'desc' },
    take: Math.min(Number(limit) || 90, 365),
  });
  // Oldest first is what a chart wants; the query takes newest-first for the
  // limit to be meaningful.
  return rows.reverse();
}

/**
 * The frozen days only, which is what calm mode is allowed to paint.
 */
export async function getCalmSeries(prisma, { userId, limit = 90 }) {
  const goal = await prisma.healthGoal.findUnique({ where: { userId } });
  const series = await getScoreSeries(prisma, { userId, limit });
  if (!goal?.calmMode) return { calmMode: false, series };

  // One flat line at the starting close, with no per-day open/high/low. Not
  // the average - the average of a chain nobody can see would still leak the
  // shape through, and the point of calm mode is that the ups and downs stop
  // being visible at all.
  const start = series.length ? series[0].open : 0;
  return {
    calmMode: true,
    series: series.map((row) => ({
      localDate: row.localDate,
      close: start,
      open: start,
      high: start,
      low: start,
      // Carried through deliberately. Calm mode flattens the value, and a flat
      // pause day would be indistinguishable from a flat ordinary day, so the
      // client would lose the one piece of information that explains why
      // nothing moved. Flattening a number is not the same as erasing the
      // reason it was flat.
      paused: row.paused === true,
      rulesVersion: row.rulesVersion,
    })),
  };
}

/**
 * Is this user in a run of very low intake?
 *
 * Read at read time, not frozen, and deliberately not gated on there being a
 * target. The guard is a safety check about the present; a user who has just
 * started and has no target yet can still be eating far too little, and that is
 * exactly when the check matters most.
 */
export async function getSafetyFlag(prisma, { userId }) {
  const recent = await prisma.scoreDaySnapshot.findMany({
    where: { userId },
    orderBy: { localDate: 'desc' },
    take: 30,
  });
  // The engine returns null when there is no run, and an object when there is.
  // Normalised to a definite shape here so the client does not have to handle
  // both "null" and "object with no keys" - the two are the same answer and
  // should look the same on the wire.
  const flag = checkForLowIntakeRun(recent.reverse());
  const goal = await prisma.healthGoal.findUnique({ where: { userId } });
  return {
    active: flag != null,
    ...(flag || {}),
    calmMode: goal?.calmMode === true,
  };
}

/** Toggle the eating-disorder guard. Never touches existing snapshots. */
export async function setCalmMode(prisma, { userId, calmMode }) {
  return prisma.healthGoal.update({
    where: { userId },
    data: { calmMode: calmMode === true },
  });
}

// --- Pause ------------------------------------------------------------------

/**
 * Is `localDate` inside this user's pause? Inclusive at both ends.
 *
 * BOTH bounds are required. A row with only one of them set is treated as not
 * paused at all, rather than as a pause with no end.
 *
 * This is the defensive direction, and it is deliberate. The two columns are
 * always written together by setPause, so a half-written pause should not
 * exist - but if one ever did, "paused from this date onward, forever" is the
 * worst possible reading of it, because an unbounded pause is precisely what
 * MAX_PAUSE_DAYS exists to prevent. Scoring a paused user normally is a
 * recoverable annoyance; pausing them indefinitely is not. They can press
 * pause again.
 *
 * An expired pause stops being paused on its own, with nothing to clear it: the
 * comparison is against the day being scored, so a user who abandoned the app
 * mid-pause is scored normally again the moment the window passes.
 */
export function isPausedOn(goal, localDate) {
  if (!goal?.pausedFrom || !goal?.pausedUntil) return false;
  if (localDate < goal.pausedFrom) return false;
  if (localDate > goal.pausedUntil) return false;
  return true;
}

/**
 * The pause, plus what the client needs to render and validate against.
 *
 * `active` is computed against `today` rather than stored, so a pause that has
 * run out reports itself as inactive without anything having to expire it.
 * `daysLeft` is inclusive of today, so a pause ending today reads as 1, not 0 -
 * telling someone they have "0 days left" on the day they can still use it is
 * the kind of off-by-one that makes people think the app is broken.
 */
export async function getPauseState(prisma, { userId, today }) {
  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: { pausedFrom: true, pausedUntil: true },
  });
  const active = isPausedOn(goal, today);
  return {
    active,
    pausedFrom: goal?.pausedFrom ?? null,
    pausedUntil: goal?.pausedUntil ?? null,
    daysLeft: active ? daysInclusive(goal.pausedUntil, today) : 0,
    maxDays: MAX_PAUSE_DAYS,
  };
}

/**
 * Start a pause, capped at MAX_PAUSE_DAYS from the start date.
 *
 * `days` is clamped rather than rejected. Asking for 30 and silently getting 14
 * is the right failure here: the user wanted a pause and got one, whereas a 422
 * would leave them with a screen that refuses to help at the exact moment they
 * asked for it. The response reports the real bounds and the cap, so the client
 * can say what actually happened instead of showing 30 and being wrong.
 *
 * A pause cannot start in the past. Every day before today is already frozen
 * into a snapshot, so a backdated pause could not take effect even if it were
 * accepted - and accepting it would suggest otherwise. That is refused outright
 * so the API never returns a pause that is quietly not doing anything.
 */
export async function setPause(prisma, { userId, days, today }) {
  // Checked here as well as in the controller, because this function writes the
  // column. A malformed `today` would produce a window that never matches a real
  // day - a pause that reports itself as active and does nothing, which is worse
  // than no pause at all.
  if (!isIsoDay(today)) {
    throw new Error('today must be YYYY-MM-DD');
  }

  const requested = Math.max(1, Math.min(Number(days) || MAX_PAUSE_DAYS, MAX_PAUSE_DAYS));
  const until = addDaysLocal(today, requested - 1);

  const goal = await prisma.healthGoal.findUnique({ where: { userId } });
  if (!goal) throw new Error('No goal set');
  // Only a pause that is still IN PROGRESS is protected. An expired pause has
  // already lapsed, and locking a user out of the feature because a fortnight
  // ago they used it would be absurd - the check is isPausedOn(today), not
  // merely "pausedFrom is in the past".
  if (isPausedOn(goal, today)) {
    throw new Error('A pause already in progress cannot be backdated');
  }

  const updated = await prisma.healthGoal.update({
    where: { userId },
    data: { pausedFrom: today, pausedUntil: until },
    select: { pausedFrom: true, pausedUntil: true },
  });

  return {
    active: true,
    pausedFrom: updated.pausedFrom,
    pausedUntil: updated.pausedUntil,
    daysLeft: daysInclusive(updated.pausedUntil, today),
    maxDays: MAX_PAUSE_DAYS,
    // True when the request was longer than the cap, so the client can say so.
    capped: requested < (Number(days) || 0),
  };
}

/** Resume now. Clears both bounds, so the next day scores normally. */
export async function clearPause(prisma, { userId }) {
  await prisma.healthGoal.update({
    where: { userId },
    data: { pausedFrom: null, pausedUntil: null },
  });
  return { active: false, pausedFrom: null, pausedUntil: null, daysLeft: 0, maxDays: MAX_PAUSE_DAYS };
}

// --- internals -------------------------------------------------------------

/**
 * A real calendar day in 'YYYY-MM-DD'.
 *
 * Not a regex alone. `/^\d{4}-\d{2}-\d{2}$/` happily accepts '2026-13-45',
 * which Date.UTC then silently rolls forward into a valid date in the next
 * year - so a pause written from garbage input would land on a real day in the
 * wrong month, and report itself as active. The round-trip check is what makes
 * "is this a day" mean a day the user could actually be living through.
 *
 * Exported because the controller needs the same notion of valid, and two
 * different definitions of a valid date in one feature is how the boundary ends
 * up accepting what the service rejects.
 */
export function isIsoDay(value) {
  const s = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Local-date string arithmetic, in and out as 'YYYY-MM-DD'.
//
// Not reusing the addDays/daysBetween in goalService and ledgerIntakeService:
// those are private to their modules and exchange `Date` objects, while a day
// boundary here is a user's local day, and the value that goes into pausedFrom
// and pausedUntil has to be the same string the rest of the ledger stores. A
// Date that round-trips through a timezone is exactly the bug that makes a
// pause start a day early.
function addDaysLocal(localDate, days) {
  const [y, m, d] = localDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Days from `from` to `to` inclusive of both ends, so one day reads as 1. */
function daysInclusive(until, from) {
  if (!until) return 0;
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = until.split('-').map(Number);
  const ms = Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1);
  return Math.floor(ms / 86400000) + 1;
}

async function previousClose(prisma, { userId, localDate }) {
  const prev = await prisma.scoreDaySnapshot.findFirst({
    where: { userId, localDate: { lt: localDate } },
    orderBy: { localDate: 'desc' },
  });
  // Null for the first day ever. The score starts at 0, deliberately, rather
  // than at a baseline invented to make the first chart look encouraging.
  return prev ? Number(prev.close) : 0;
}

async function gatherDayInputs(prisma, { userId, localDate, today }) {
  const { totals, bySlot } = await getDayTotals(prisma, userId, localDate);

  const items = await prisma.planItem.findMany({
    where: { userId, active: true },
    include: { completions: { where: { localDate } } },
  });

  const planItems = [];
  const completions = [];
  for (const item of items) {
    if (item.endsOn && localDate > item.endsOn) continue;
    if (!isDueOn(item, localDate, today)) continue;
    planItems.push(item);
    for (const c of item.completions || []) {
      completions.push({ ...c, planItemId: item.id });
    }
  }

  // Whether a workout was actually LOGGED that day, as opposed to merely being
  // scheduled. The engine needs this to decide if an extra workout was
  // unplanned, and "scheduled" is the wrong signal for that question: someone
  // who skipped the plan and trained anyway has an unplanned workout, and
  // someone who trained on a rest day has an unplanned workout too. Only
  // `hasPlannedWorkoutDone` distinguishes either of those from a user who
  // completed their plan.
  const completedItemIds = new Set(completions.map((c) => c.planItemId));
  const scheduledWorkout = planItems.some((i) => i.kind === 'workout');
  const hasPlannedWorkoutDone = planItems.some(
    (i) => i.kind === 'workout' && completedItemIds.has(i.id),
  );

  // A logged session on this localDate. Filtered in the query rather than in JS
  // because a user with years of sessions should not have all of them loaded to
  // find one day's worth.
  //
  // `endedAt` and `type` both matter. A draft that was started and abandoned is
  // not a workout — it is a row that would otherwise score points for a session
  // the user did not finish. And `type = 'rest'` is the schema's own way of
  // recording a deliberate rest day, which is the opposite of an extra workout;
  // scoring it as one would pay points for resting, in a system whose entire
  // premise is that the score never punishes rest.
  const sessions = await prisma.workoutSession.findMany({
    where: { userId, localDate, endedAt: { not: null } },
    select: { id: true, type: true, endedAt: true },
  });
  const loggedWorkout = sessions.some((s) => s.type !== 'rest');

  return {
    planItems,
    completions,
    totals,
    // Kept as "is one scheduled", because that is what the engine's
    // planned-vs-unplanned split is about. Both are passed: the engine needs to
    // know whether a plan existed to compare an extra session against, and
    // whether the plan's workout was actually done.
    hasPlannedWorkout: scheduledWorkout,
    hasPlannedWorkoutDone,
    // Now derived rather than defaulting to false. Before this, the "extra
    // workout" line in the engine was unreachable: nothing ever passed the
    // flag, so POINTS.unplannedWorkout was dead code and a user who trained on
    // a rest day got nothing for it.
    unplannedWorkout: loggedWorkout && !hasPlannedWorkoutDone,
    bySlot,
  };
}
