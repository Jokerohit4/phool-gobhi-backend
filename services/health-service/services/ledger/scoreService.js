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
import { RULES_VERSION, DECIMAL_PLACES, roundTo } from './constants.js';
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

  const day = computeDay({
    localDate,
    previousClose: previous,
    ...inputs,
    targets: target,
    closed: true,
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

// --- internals -------------------------------------------------------------

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

  return {
    planItems,
    completions,
    totals,
    hasPlannedWorkout: planItems.some((i) => i.kind === 'workout'),
    bySlot,
  };
}
