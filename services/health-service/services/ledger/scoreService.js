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
import { RULES_VERSION, DECIMAL_PLACES, roundTo, MAX_PAUSE_DAYS, BIOLOGICAL_TARGETS } from './constants.js';
import { computeDay, checkForLowIntakeRun, computeBiologicalScore, computeBlendedHealthScore } from './scoreEngine.js';
import { getDayTotals } from './nutritionService.js';
import { isDueOn } from './ledgerPlanService.js';
import { isScheduledFor } from './scoreEngine.js';
import { openActions } from './remediation.js';
import { assertGoal } from './goalGuard.js';
import { currentNutritionTarget } from './currentTarget.js';
import { isIsoDay } from './isoDay.js';
import redis from '../../utils/redisClient.js';
import { blendedScoreCacheKey } from './blendedScoreCache.js';

const CACHE_TTL = 3600; // 1 hour

/**
 * Compute (but do not store) what a day is worth.
 *
 * Kept separate from `closeDay` so the app can show today's running score
 * without a snapshot row existing for today. Only a closed day gets frozen.
 */
export async function previewDay(prisma, { userId, localDate, today }) {
  const inputs = await gatherDayInputs(prisma, { userId, localDate, today });
  const target = await currentNutritionTarget(prisma, userId);
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
  //
  // A day is closed when it is before today. Hoisted because two things now
  // depend on it: the engine's own miss pass, and whether this day may carry an
  // action list at all.
  const closed = localDate < today;
  return {
    ...computeDay({
      localDate,
      previousClose: previous,
      ...inputs,
      targets: target,
      closed,
      paused: isPausedOn(goal, localDate),
    }),
    // What is still open today, attached to the day itself rather than served
    // separately. Two reasons it rides along here: the app already fetches the
    // preview on every hub render, so a second endpoint would be a round trip to
    // show something this response already knows; and actions computed from a
    // *different* read of the plan could describe work the user has already done.
    openActions: previewActions({ ...inputs, localDate, closed }),
  };
}

/**
 * What is still open on `localDate`, for the day payload.
 *
 * The inputs have already been through `gatherDayInputs`, which drops inactive
 * items, items past their `endsOn`, and anything `isDueOn` says is not due. So
 * there is nothing left for this to re-check, and it deliberately does not: a
 * second copy of those rules here would be a place for them to drift away from
 * the ones the day is actually scored with, and the drift would show up as the
 * app telling somebody to do something the engine never asked for.
 *
 * `isScheduledFor` is passed anyway, so this stays correct if a caller ever
 * hands it unfiltered items - and so the predicate under test is the engine's
 * rather than a stand-in.
 */
function previewActions({ planItems = [], completions = [], localDate, closed }) {
  // A frozen day gets nothing, and this is the one rule the module cannot infer
  // for itself. A preview of a past date is a historical read: the snapshot will
  // never be recomputed, so every action on it would be a tap that cannot work.
  // The check lives here rather than in the caller because the caller is the
  // only place that knows, and forgetting it there is exactly the bug.
  if (closed) return [];
  return openActions({ planItems, completions, localDate }, { isScheduledFor });
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
  if (existing) {
    // `openActions: []` is not decoration. A closed day has no open work - the
    // plan moved on and the snapshot will never be recomputed - but the field
    // has to be present so a client can tell "nothing is open" apart from
    // "this response predates the field", which would otherwise read as a
    // payload the app failed to understand.
    return { ...existing, alreadyClosed: true, openActions: [] };
  }

  const inputs = await gatherDayInputs(prisma, { userId, localDate, today });
  const target = await currentNutritionTarget(prisma, userId);
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

  // A day being closed is by definition closed, so the open list is empty.
  // Spelled out rather than left to the reader, because "why is this always
  // empty?" is the obvious question and the answer is not obvious.
  let row;
  try {
    row = await prisma.scoreDaySnapshot.create({
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
  } catch (err) {
    // Lost a race to another closer. Since the server started closing
    // yesterday on a schedule (dayCloseService), "two closers for the same day"
    // is no longer only a double-tap: the nightly sweep and a user pressing
    // close just after midnight can both pass the findUnique above. The
    // (userId, localDate) unique rejects the second insert, and the right
    // answer is the row that won - exactly what a plain retry gets. Never an
    // overwrite, and never a 500 for a day that is in fact closed.
    if (err?.code !== 'P2002') throw err;
    const winner = await prisma.scoreDaySnapshot.findUnique({
      where: { userId_localDate: { userId, localDate } },
    });
    if (!winner) throw err;
    return { ...winner, alreadyClosed: true, openActions: [] };
  }
  return { ...row, openActions: [] };
}

export async function getBlendedScore(prisma, { userId }) {
  const cacheKey = blendedScoreCacheKey(userId);
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Parallelize the behavioral baseline and biological state fetches
  const [latestSnapshot, bioEntries, averages] = await Promise.all([
    prisma.scoreDaySnapshot.findFirst({
      where: { userId },
      orderBy: { localDate: 'desc' },
    }),
    // No `metric` filter on purpose. This used to pass
    // Object.keys(BIOLOGICAL_TARGETS) — the blood-panel markers hba1c, ldl,
    // hdl and triglycerides — but not one of those is a member of the
    // BiometricMetric enum, and Prisma rejects the entire findMany when any
    // value in `in` is not an enum member ("Invalid value for argument `in`.
    // Expected BiometricMetric."), so every blended-score read threw instead
    // of scoring. Filtering was never load-bearing: scoreEngine already skips
    // any marker with no target (`if (!target) continue`), so reading the
    // user's entries and letting the engine match them scores the same set
    // today, and starts including the blood markers unchanged if the enum ever
    // grows them.
    //
    // The `verified: true` that used to sit here went for the same class of
    // reason: BiometricEntry has no such column (only FoodItem.verified and
    // ReportExtraction.isVerified exist), so Prisma rejected the query with
    // "Unknown argument 'verified'" on every read. It was never a real filter
    // either — a row here is either typed by the user, or written by
    // verifyExtractionService, which only writes once the user has confirmed
    // the value. So every row is confirmed by construction.
    prisma.biometricEntry.findMany({
      where: {
        userId,
      },
      // By the day the value belongs to, not when it was typed or verified:
      // confirming a 2024 report after a 2026 one must not make 2024 "latest".
      // localDate is 'YYYY-MM-DD', so string order is date order.
      orderBy: [{ localDate: 'desc' }, { createdAt: 'desc' }],
    }),
    behavioralAverages(prisma, { userIds: [userId] }),
  ]);

  const ledgerClose = latestSnapshot ? Number(latestSnapshot.close) : 0;

  // Group by marker to get only the latest for each
  const latestBiomarkers = [];
  const seen = new Set();
  for (const entry of bioEntries) {
    if (!seen.has(entry.metric)) {
      latestBiomarkers.push({
        marker: entry.metric,
        value: Number(entry.value),
      });
      seen.add(entry.metric);
    }
  }

  const bioScore = computeBiologicalScore(latestBiomarkers);
  const blendedScore = computeBlendedHealthScore(ledgerClose, bioScore);

  const result = {
    blendedScore,
    behavioralScore: ledgerClose,
    // The 0-100 the blend actually used. behavioralScore is the ledger's raw
    // running close (hundreds of points), which the card was printing as a
    // percentage beside a biological score that really is 0-100.
    behavioralPercent: Math.round(computeBlendedHealthScore(ledgerClose, null)),
    biologicalScore: bioScore,
    markers: latestBiomarkers,
    // What the weekly-bonus bar shows, and the exact figure rewardService pays
    // on. The app has always read this field; nothing ever sent it, so the bar
    // sat at 0.0% for everyone.
    behavioralAvg7Day: averages.get(userId) ?? 0,
  };

  await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
  return result;
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

export const CONSISTENCY_WINDOW_DAYS = 7;

export function todayIST(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function shiftDay(localDate, days) {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The 7-day behavioural average, 0-100, for each user: the mean of the last
 * seven CLOSED days' behaviour score (the same 0-100 normalisation the blend
 * uses), with a day that has no snapshot counted as 0.
 *
 * One definition for three readers - the weekly-bonus bar on the Health Score
 * card, the weekly coin reward, and buddy-service's consistency leagues - so
 * the bar can never say "unlocked" for a number the reward does not pay on.
 *
 * Divided by 7, not by the days present, on purpose: "keep it up for 7 days"
 * has to mean all seven. Averaging only the days that exist would let a single
 * great day read as a perfect week.
 *
 * This replaces reads of a `dailyScore` model that never existed in the
 * schema, which made every reward evaluation and every league request throw.
 */
export async function behavioralAverages(prisma, { userIds, today = todayIST() }) {
  const from = shiftDay(today, -CONSISTENCY_WINDOW_DAYS);
  const snapshots = await prisma.scoreDaySnapshot.findMany({
    where: { userId: { in: userIds }, localDate: { gte: from, lt: today } },
    select: { userId: true, close: true },
  });

  const sums = new Map();
  for (const s of snapshots) {
    const pct = computeBlendedHealthScore(Number(s.close), null);
    sums.set(s.userId, (sums.get(s.userId) ?? 0) + pct);
  }

  const result = new Map();
  for (const [userId, sum] of sums) {
    result.set(userId, Math.round((sum / CONSISTENCY_WINDOW_DAYS) * 10) / 10);
  }
  return result;
}

/**
 * Fetches behavioral consistency for a list of users.
 * Used by the buddy-service to build consistency leagues.
 */
export async function getBatchBehavioralConsistency(prisma, { userIds }) {
  const averages = await behavioralAverages(prisma, { userIds });
  return [...averages].map(([userId, avgScore]) => ({ userId, avgScore }));
}

/**
 * Fetches the history of a specific biomarker. Every stored row is confirmed
 * by construction (typed by the user, or written only after the user confirms
 * an OCR extraction), so there is nothing to filter on here.
 */
export async function getBiomarkerTrajectory(prisma, { userId, marker, days = 90 }) {
  const dateLimit = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const entries = await prisma.biometricEntry.findMany({
    where: {
      userId,
      metric: marker,
      createdAt: { gte: new Date(dateLimit) },
    },
    orderBy: { createdAt: 'asc' },
  });

  return entries.map(e => ({
    date: e.createdAt.toISOString().split('T')[0],
    value: Number(e.value),
  }));
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

/**
 * Toggle the eating-disorder guard. Never touches existing snapshots.
 *
 * `updateMany` rather than `update`, so this cannot throw P2025 on a user with no
 * goal row - a user with no goal has no days being scored, so the setting has
 * nothing to apply to, and a toggle that 500s is worse than one that quietly has
 * no effect until there is a goal for it to apply to. Deliberately NOT a 409 like
 * the window-creating writes: calm mode is a protection, and refusing to record
 * that somebody asked for it because their setup is incomplete would be protecting
 * them from the wrong thing.
 */
export async function setCalmMode(prisma, { userId, calmMode }) {
  const wanted = calmMode === true;
  const res = await prisma.healthGoal.updateMany({
    where: { userId },
    data: { calmMode: wanted },
  });
  // The response echoes what is STORED, not what was asked for. Those are the
  // same thing whenever a goal row exists and different whenever it does not,
  // and the difference is the whole problem: a user with no goal has nowhere to
  // keep a display preference, so the write cannot be honoured, and returning
  // `wanted` would tell the client to render a preference that does not exist.
  //
  // That is not hypothetical. The app reads this flag and deliberately renders
  // the echo rather than the tap ("so a toggle cannot render a preference the
  // server did not actually accept"), so echoing the request here would let a
  // user switch calm mode on, see it stay on, and have it silently gone by the
  // next launch. A toggle that lies is worse than one that refuses.
  //
  // `false` is the honest value rather than a second read, and not as a
  // shortcut: `count === 0` means no row matched `{ userId }`, so a lookup by
  // that same key would return null, and no row means no stored preference.
  // `applied` is returned so a caller that wants to distinguish "you turned it
  // off" from "there was nothing to turn it off on" can, without the client
  // having to infer it from a false that might mean either.
  return { calmMode: res?.count > 0 ? wanted : false, applied: res?.count > 0 };
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
    // Present on the read for the same reason it is on the target read: "no goal"
    // and "not paused" are different answers, and a client told only that a user
    // is not paused cannot know whether pausing them would work.
    hasGoal: goal != null,
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
  // A 409 with a code, not a bare 500. See goalGuard: a pause needs the goal row
  // the intake wizard creates, and the user is told to go and finish it rather
  // than shown "Server error".
  assertGoal(goal);
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

/**
 * Resume now. Clears both bounds, so the next day scores normally.
 *
 * `updateMany`, for the reason in goalGuard: `update` throws Prisma P2025 on a
 * user with no goal row, and that error was reaching the client as a 500 whose
 * body was the Prisma invocation. Resuming when there is nothing paused is not an
 * error - it is the state the caller asked for - so it succeeds and says so.
 *
 * The row is read as well as written so the response can state `hasGoal` rather
 * than assume it.
 */
export async function clearPause(prisma, { userId }) {
  const goal = await prisma.healthGoal.findUnique({ where: { userId }, select: { userId: true } });

  await prisma.healthGoal.updateMany({
    where: { userId },
    data: { pausedFrom: null, pausedUntil: null },
  });

  return {
    active: false,
    pausedFrom: null,
    pausedUntil: null,
    daysLeft: 0,
    maxDays: MAX_PAUSE_DAYS,
    hasGoal: goal != null,
  };
}

// --- internals -------------------------------------------------------------

// Re-exported from the shared module rather than defined here: the controller
// and the nutrition service both need this exact notion of a valid day, and one
// definition is what keeps the boundary from accepting what the writer rejects.
// Kept on this namespace because callers have imported `scoreService.isIsoDay`
// for a while.
export { isIsoDay };

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

/**
 * The close the chain carried into `localDate` - i.e. the score as it stood
 * before that day earned anything.
 *
 * Exported (it was private) for the score target, which needs "the score when
 * this window started" and should get it from the same single definition rather
 * than re-querying the last snapshot with subtly different ordering or
 * bounds. Returns 0 for a user's first ever day: the score starts at 0
 * deliberately, not at a baseline invented to make the first chart look
 * encouraging.
 */
export async function previousClose(prisma, { userId, localDate }) {
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
