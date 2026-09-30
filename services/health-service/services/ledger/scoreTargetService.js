// The score's answer to "what number am I trying to hit".
//
// The engine produces a number every day and has no opinion about what any of
// them are for. It answers "where am I" and never "where am I going", which is
// why this is a separate service from scoreService rather than a field on the
// day: a target is chosen, and a day is observed.
//
// ── What a target is ────────────────────────────────────────────────────────
//
// A threshold on the RUNNING TOTAL, plus a window the user gave themselves.
// "Get to 400 points by the 30th." Not points earned within the window, and not
// a streak the app keeps on the user's behalf. The distinction is the whole
// design, and it is easy to get backwards:
//
//   The score can fall. A missed doctor item is -10, a missed planned workout is
//   -15, a missed habit is -3, and a day loses up to 40. So progress toward a
//   running-total target can go backwards, and a card that hid that would be
//   lying about a number the user is looking at on the same screen.
//
// The alternative - summing only points earned inside the window - is strictly
// increasing and would match "keeps on increasing" literally. It was not chosen
// because it credits a day whose gains were later clawed back by misses on the
// same day, and because it makes the target a different kind of object from the
// score: a user who looks at a line on a chart is asking about that line, not
// about a sum the app computed out of sight.
//
// A target is stored as an ABSOLUTE number, not "N more than where you are now".
// The two readings differ by the user's entire history, and the absolute one is
// what a person means when they point at a number.
//
// ── The three bands ─────────────────────────────────────────────────────────
//
// `on_track` / `at_risk` / `behind` are about PACE, not about absolute progress.
// Someone on day 2 of 30 with 3% of the distance covered is exactly on pace and
// should not see a warning; someone on day 28 with 97% covered is not nearly done
// and should be told so. A band computed from progress alone gets both of those
// backwards, which is the reason the card compares distance against time rather
// than against nothing.
//
// The margins are asymmetric, deliberately. `at_risk` is a wide band because
// nearly every real day is slightly off the straight line, and a 2% band would
// put almost every user in amber permanently - an alert that is always on is not
// an alert. `behind` is a narrower band because it is the one that earns the
// colour, and a red card that appears for one missed item would be a red card
// the user learns to ignore. Green is the default and needs nothing special.
//
// These are paint, not verdicts. Nothing here changes a stored number, and
// `band` is the only thing the client is asked to colour with.
import { roundTo } from './constants.js';
// Static, not dynamic. scoreService does not import this module, so there is no
// cycle for a lazy import to break, and a lazy import here would only hide the
// fact that the dependency is fine. `previousClose` is imported rather than
// re-queried so "the score at the start of a day" has exactly one definition in
// the ledger.
import { isIsoDay, previewDay, previousClose } from './scoreService.js';

// Bounds on what a user may set, enforced here rather than in the client so
// that calling the endpoint directly cannot buy a longer or easier target than
// the app offers.
export const TARGET_LIMITS = {
  minPoints: 1,
  // Not a number the engine would ever hand out (a day gains at most 60, and the
  // chain starts at 0), so this is only ever a sanity ceiling against a typo or a
  // pasted value. Deliberately generous rather than tight: refusing a target
  // because it looks ambitious would be the app second-guessing a number the
  // user is allowed to pick.
  maxPoints: 100000,
  minDays: 1,
  // A year. Long enough to be a real "this year" goal, short enough that a
  // mistake is still recoverable - at any rate the user is not silently signed up
  // to a target they cannot finish.
  maxDays: 365,
};

const PACED_BANDS = {
  // Ahead of or level with the required rate.
  onTrackMinPace: 1.0,
  // Behind, but within this fraction of the target's distance. The wide one.
  atRiskMinPace: 0.85,
  // Behind by more than that: `behind`.
};

/**
 * Set (or replace) the target.
 *
 * Replaces rather than refuses when one is already live. A user editing their
 * own goal is the normal case, not an edge case, and there is no second target
 * worth protecting - the previous one had no history that the new one would
 * lose, because the window is the thing being changed and it is re-derived from
 * `days` against `today` every time.
 *
 * A target that is already met, or already expired, is refused. Accepting either
 * would produce a card that reports a target the user cannot act on - the two
 * states the feature exists to avoid. The error says which one it is, so the
 * client can offer the right follow-up (lower the number, or pick a new window).
 */
export async function setScoreTarget(prisma, { userId, points, days, today }) {
  if (!isIsoDay(today)) {
    // Same reason as setPause: this function writes the window, and a malformed
    // `today` would write a window that can never match a real day - a target
    // that reports itself as running and is not.
    throw new Error('today must be YYYY-MM-DD');
  }

  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: {
      pausedFrom: true,
      pausedUntil: true,
      scoreTargetPoints: true,
      scoreTargetFrom: true,
      scoreTargetUntil: true,
    },
  });
  if (!goal) throw new Error('No goal set');

  const target = Math.round(Number(points));
  const windowDays = Math.round(Number(days));

  if (!Number.isFinite(target) || target < TARGET_LIMITS.minPoints || target > TARGET_LIMITS.maxPoints) {
    throw new Error(`Target score must be between ${TARGET_LIMITS.minPoints} and ${TARGET_LIMITS.maxPoints}`);
  }
  if (!Number.isFinite(windowDays) || windowDays < TARGET_LIMITS.minDays || windowDays > TARGET_LIMITS.maxDays) {
    throw new Error(`Target window must be between ${TARGET_LIMITS.minDays} and ${TARGET_LIMITS.maxDays} days`);
  }

  const until = addDaysLocal(today, windowDays - 1);

  // Already-expired is impossible for a window that starts today, so only the
  // "already met" case can actually fire here - but it is checked against the
  // score the user is about to be measured against, not against the target
  // they typed, so a lower number on an existing target is caught too.
  const current = await currentScore(prisma, { userId, today });
  const baseline = await baselineScore(prisma, { userId, from: today });
  if (current != null && current >= target) {
    throw new Error('That target is already reached. Pick a higher score or set a new one.');
  }

  const updated = await prisma.healthGoal.update({
    where: { userId },
    data: { scoreTargetPoints: target, scoreTargetFrom: today, scoreTargetUntil: until },
  });

  return buildState({
    goal: updated,
    today,
    current,
    baseline,
  });
}

/** Remove the target. The score is untouched - only the destination goes away. */
export async function clearScoreTarget(prisma, { userId }) {
  await prisma.healthGoal.update({
    where: { userId },
    data: { scoreTargetPoints: null, scoreTargetFrom: null, scoreTargetUntil: null },
  });
  return { active: false, points: null, from: null, until: null, daysLeft: 0, daysTotal: 0, band: 'none' };
}

/**
 * The target, and how the running total is doing against it.
 *
 * Read-only, and safe to call on a user with no goal - it reports `none` rather
 * than throwing, so the client can render "no target set" without having to know
 * whether a goal exists yet.
 */
export async function getScoreTargetState(prisma, { userId, today }) {
  if (!isIsoDay(today)) throw new Error('today must be YYYY-MM-DD');

  const goal = await prisma.healthGoal.findUnique({
    where: { userId },
    select: {
      pausedFrom: true,
      pausedUntil: true,
      scoreTargetPoints: true,
      scoreTargetFrom: true,
      scoreTargetUntil: true,
    },
  });
  if (!goal || goal.scoreTargetPoints == null) {
    return { active: false, points: null, from: null, until: null, daysLeft: 0, daysTotal: 0, band: 'none' };
  }

  const current = await currentScore(prisma, { userId, today });
  const baseline = await baselineScore(prisma, { userId, from: goal.scoreTargetFrom });
  return buildState({ goal, today, current, baseline });
}

// --- internals -------------------------------------------------------------

/**
 * The live score: today's preview if today is still open, otherwise the last
 * closed day.
 *
 * The preview is what makes the card move while the user is logging. Reading only
 * the last snapshot would freeze the target at yesterday's number until midnight,
 * which on the day the user is actually trying to hit the target is the one time
 * a stale number is most misleading.
 *
 * Null when the user has never had a scored day, so the caller can tell "score
 * 0" apart from "no score yet". They are different: 0 is a real total that the
 * user earned by missing everything, and treating it as missing data would
 * quietly hide a red start.
 */
async function currentScore(prisma, { userId, today }) {
  const preview = await previewDay(prisma, { userId, localDate: today, today });
  if (preview && Number.isFinite(Number(preview.close))) return Number(preview.close);

  const last = await prisma.scoreDaySnapshot.findFirst({
    where: { userId },
    orderBy: { localDate: 'desc' },
    select: { close: true },
  });
  return last ? Number(last.close) : null;
}

/**
 * The score the user started the window on: the last close strictly before
 * `scoreTargetFrom`.
 *
 * Derived, never stored. Storing it would be a second copy of a number that
 * already exists in the frozen snapshot history, and a stored copy is a copy that
 * can disagree with the history it was copied from. Reading previousClose means
 * the baseline is whatever the chain actually said on the last day before the
 * window, which is the definition the chart itself is drawn from.
 */
async function baselineScore(prisma, { userId, from }) {
  return previousClose(prisma, { userId, localDate: from });
}

function buildState({ goal, today, current, baseline }) {
  const points = goal.scoreTargetPoints;
  const from = goal.scoreTargetFrom;
  const until = goal.scoreTargetUntil;

  const daysTotal = Math.max(0, daysInclusive(until, from));
  const daysLeft = Math.max(0, daysInclusive(until, today));

  // Elapsed counts COMPLETED days only, so today is excluded while it is still
  // open. This is the difference between a new target reading as neutral and every
  // new target reading as red. On the day the user sets a target they have earned
  // nothing yet, because the day is not over; counting it as a lost day would say
  // "behind" for the hours the user has not had yet. It also matches the score
  // itself, which is a live preview until the day closes.
  const lastCompleted = addDaysLocal(today, -1);
  const elapsedEnd = lastCompleted < until ? lastCompleted : until; // clip to window end
  const daysElapsed = elapsedEnd < from ? 0 : daysInclusive(elapsedEnd, from);

  // Days the user was told to stop, inside the window, are days that did not run.
  //
  // A pause freezes the score, and this card is measured on the score, so
  // counting paused days as lost would report a user as "behind" for a fortnight
  // they were explicitly told to take off. The pause does not extend the
  // deadline - that would be extending a deadline because the thing being
  // measured stopped moving - it only stops those days counting as elapsed. The
  // pace maths therefore stays honest while the band stops penalising a rest.
  //
  // Subtracted from completed days (which already exclude today), so a pause
  // covering today reduces neither count twice.
  const pausedInWindow = pausedDaysInWindow(goal, today, from, elapsedEnd);
  const daysElapsedNet = Math.max(0, daysElapsed - pausedInWindow);

  // The distance is what is left to travel from where the user actually started,
  // not the target itself. Progress is measured against the baseline so that a
  // user already at 300 who sets a 400 target sees "100 to go", not "75% done" on
  // day one - the latter would be true arithmetic and completely useless.
  const distance = Math.max(0, points - baseline);
  const covered = current == null ? 0 : current - baseline;

  // Capped at 0 and 1 so the bar is a bar and not a number that overshoots the
  // track. Negative progress is real information, so `covered` is returned raw
  // alongside it and the client can say "down from where you started" rather
  // than rendering a bar pinned at zero with no explanation.
  const progress = distance > 0 ? Math.max(0, Math.min(1, covered / distance)) : 1;

  // Pace compares the fraction of the distance covered against the fraction of
  // the window spent, NOT distance-against-elapsed. Those are different by the
  // size of the window, and the distinction is the whole reason pace is a useful
  // signal: covering 50% of the distance in half the window is pace 1.0, and the
  // same 50% with a third of the window spent is ~1.5. Dividing elapsed alone
  // would score the first case as 0.1 and call it "behind".
  //
  // Zero completed days means the window opened today, which is the neutral
  // starting state rather than an infinite (or zero) pace - see daysElapsed.
  const fractionDone = distance > 0 ? covered / distance : 1;
  const fractionTime = daysTotal > 0 ? daysElapsedNet / daysTotal : 0;
  const pace = daysElapsedNet > 0 ? fractionDone / fractionTime : null;
  const band = bandFor({ current, points, pace, today, until });

  return {
    active: true,
    points,
    from,
    until,
    current,
    baseline,
    // Raw, unclamped: the sign is the honest part.
    covered: roundTo(covered, 1),
    remaining: roundTo(Math.max(0, points - (current ?? 0)), 1),
    progress: roundTo(progress, 4),
    pace: pace == null ? null : roundTo(pace, 4),
    daysLeft,
    daysTotal,
    daysElapsed: daysElapsedNet,
    // Raw completed days, before paused days are discounted. The client does not
    // paint this - it exists so "day 5 of 10" and "5 days of those ran" can be
    // shown as the two different things they are when a pause is in play.
    daysElapsedRaw: daysElapsed,
    pausedDays: pausedInWindow,
    // `reached` and `expired` are separate from `band` on purpose: the band is
    // paint, these are the two states where there is nothing left to pace
    // towards and the client should stop showing a rate at all.
    reached: current != null && current >= points,
    expired: today > until,
    band,
    // True while a pause is covering today: the number cannot move today, so the
    // card can say so instead of showing a pace that will not change.
    pausedNow: isPausedOn(goal, today),
    limits: TARGET_LIMITS,
  };
}

function bandFor({ current, points, pace, today, until }) {
  if (current == null) return 'on_track'; // no score yet is not a failure
  if (current >= points) return 'reached';
  if (today > until) return 'expired';
  if (pace == null) return 'on_track';
  if (pace >= PACED_BANDS.onTrackMinPace) return 'on_track';
  if (pace >= PACED_BANDS.atRiskMinPace) return 'at_risk';
  return 'behind';
}

/**
 * Paused days inside the target window that have already happened.
 *
 * Counts the overlap of the pause with the target window, clipped to `today`,
 * because a pause that has not started yet cannot have lost the user any days.
 * A single pause window is the only shape the schema stores, so this is exact for
 * the one pause that is live or most recent - and it is documented as such rather
 * than pretending to handle a history the data does not have.
 */
function pausedDaysInWindow(goal, today, from, until) {
  if (!goal.pausedFrom || !goal.pausedUntil) return 0;
  const start = goal.pausedFrom > from ? goal.pausedFrom : from;
  const end = goal.pausedUntil < until ? goal.pausedUntil : until;
  const capped = end < today ? end : today;
  if (capped < start) return 0;
  return daysInclusive(capped, start);
}

function isPausedOn(goal, localDate) {
  if (!goal?.pausedFrom || !goal?.pausedUntil) return false;
  if (localDate < goal.pausedFrom) return false;
  if (localDate > goal.pausedUntil) return false;
  return true;
}

// Local-date arithmetic, matching scoreService. Duplicated rather than imported
// because scoreService keeps these private, and a second *copy of the notion* of a
// day is the thing that produces a window that starts a day early - the values
// have to be the same strings the rest of the ledger stores, so they are computed
// the same way rather than through a Date and a timezone.
function addDaysLocal(localDate, days) {
  const [y, m, d] = localDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysInclusive(until, from) {
  if (!until) return 0;
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = until.split('-').map(Number);
  const ms = Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1);
  return Math.floor(ms / 86400000) + 1;
}
