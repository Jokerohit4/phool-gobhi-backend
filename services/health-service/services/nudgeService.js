import { hourIST, isoDayIST } from '../utils/sessionDay.js';
import prisma from '../db/prisma.js';

import { notifyUser } from '../utils/notifyUser.js';
import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';
import { isWellnessProfile } from '../utils/persona.js';
import { findUnloggedUsersService } from './unloggedService.js';
import { getScoreTargetState } from './ledger/scoreTargetService.js';
import { fetchLifecycleCandidates } from '../utils/fetchLifecycleCandidates.js';
import { track } from '../utils/analytics.js';


// FR-08. Three nudges, all earned by something the user actually did or chose:
//
//   log      - attended, and 90 minutes later still hasn't said what they did
//   comeback - has logged before, and nothing for 7 days
//   target   - has a live score target and has fallen behind pace on it
//
// The BRD also specifies a book-nudge ("your usual 18:00 slot is free").
// It is NOT built here, deliberately: it needs slot availability and the
// user's booking pattern, both of which live in booking-service, which
// already owns a re-engagement sweep. Building a half-informed version in
// this service would mean two systems messaging the same user about
// booking with no shared frequency budget - which is precisely how a
// product starts spamming people.
//
// Everything below exists to make these safe rather than clever. The
// failure mode of a nudge bug is not a wrong pixel; it is a push
// notification to a real person at three in the morning.
export const NUDGE_TYPES = ['log', 'comeback', 'target'];

// Lifecycle nudges (2026-11-23): the first-week gap. A new user who never did
// a workout was eligible for none of the above. They are deliberately NOT
// workout prompts - Home shows one card at a time and workouts are not the
// first thing a new user is ready for - they point at the Today plan, a glass
// of water, a mood check-in or the streak.
//
//   onboarding_resume   - signed up, never finished onboarding (3h-48h)
//   first_step          - finished onboarding, no activity of any kind (24h-72h)
//   first_step_followup - still nothing (72h-7d)
//
// Each is sent AT MOST ONCE per user, ever (see canSendService). Users who go
// quiet later, and users inactive 7+ days who never finished a workout, are
// handled by the generalised `comeback` (variant 'soft').
export const LIFECYCLE_TYPES = ['onboarding_resume', 'first_step', 'first_step_followup'];

// One opt-out row (`lifecycle`) silences all LIFECYCLE_TYPES, so the settings
// screen gets one extra switch instead of three. NUDGE_TYPES stays the set of
// types that can actually be SENT under their own name.
export const LIFECYCLE_OPT_OUT = 'lifecycle';
export const OPT_OUT_TYPES = [...NUDGE_TYPES, LIFECYCLE_OPT_OUT];

export function optOutKey(type) {
  return LIFECYCLE_TYPES.includes(type) ? LIFECYCLE_OPT_OUT : type;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RESUME_FROM_HOURS = 3;
const RESUME_UNTIL_HOURS = 48;
const FIRST_STEP_FROM_HOURS = 24;
const FIRST_STEP_UNTIL_HOURS = 72;
const FOLLOWUP_UNTIL_HOURS = 7 * 24;
// The soft comeback can repeat while someone stays quiet (the workout one
// does too); this spaces it to once per fortnight so a long absence is not
// three pushes in a week.
const SOFT_COMEBACK_COOLDOWN_DAYS = 14;

// PRD S7.4: max 3 a week, never two within 24 hours, quiet 22:00-09:00.
export const MAX_PER_WEEK = 3;
export const MIN_GAP_HOURS = 24;
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 9;

// `target` is the one nudge whose condition can stay true for weeks: someone
// behind on a 30-day target is behind again tomorrow, and the day after. The
// global 24h gap and weekly cap are built for events (a check-in, a lapse)
// and would let a persistent shortfall become three near-identical pushes a
// week. A longer floor per type keeps "you are behind" a prompt rather than a
// nag, without touching the shared budget the other two rely on.
export const TARGET_MIN_GAP_HOURS = 72;

const LOG_NUDGE_AFTER_MINUTES = 90;
const LOG_NUDGE_WINDOW_HOURS = 12;
const COMEBACK_AFTER_DAYS = 7;
// Someone who stopped months ago is not "coming back" - past this they are
// churned, and a push is an intrusion rather than a reminder.
const COMEBACK_UNTIL_DAYS = 60;

/// Local hour in IST, which is where every user is today. Kept as one
/// function so the quiet-hours rule has a single definition to change when
/// that stops being true.
export function localHour(now = new Date()) {
  return hourIST(now);
}

export function isQuietHours(now = new Date()) {
  const hour = localHour(now);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/// The IST day `now` falls on, 'YYYY-MM-DD'. The score target's window is
/// expressed in these strings, so picking candidates means comparing the same
/// kind of value the card does. Same one-function reasoning as [localHour].
export function localDateIST(now = new Date()) {
  return isoDayIST(new Date(now));
}

/// IST hours [from, to) each onboarding "when are you usually free" answer
/// allows a comeback nudge in. Onboarding promised these answers time
/// reminders; this is what makes that true.
///
/// Every window lies inside the 09:00-22:00 sending day, so quiet hours still
/// win outright. "Late nights" can't be honoured literally without breaking
/// them, so it maps to the last two hours before quiet hours start — the
/// nearest time we're willing to send — and the onboarding copy says so.
///
/// The sweep runs at 09, 11, 13, 15, 17, 19 and 21 IST (send-health-nudges.yml),
/// so every window contains at least one run. A window with no run in it would
/// silently mean "never".
export const FREE_TIME_HOURS = {
  morning: [9, 12],
  afternoon: [12, 17],
  evening: [17, 22],
  late_night: [20, 22],
};

/// Whether now falls in this user's free-time window. No answer, "it varies",
/// or a value we don't know all mean "any time in the sending day": not
/// knowing when someone is free is no reason to never remind them.
export function isWithinFreeTime(freeTimeWindow, now = new Date()) {
  const hours = FREE_TIME_HOURS[freeTimeWindow];
  if (!hours) return true;
  const hour = localHour(now);
  return hour >= hours[0] && hour < hours[1];
}

/// Whether this user may be sent this nudge right now. Checks the opt-out
/// first because it is the user's own instruction and outranks everything
/// else here.
export async function canSendService(userId, type, now = new Date(), opts = {}) {
  const optedOut = await prisma.nudgeOptOut.findUnique({
    where: { userId_type: { userId, type: optOutKey(type) } },
  });
  if (optedOut) return { allowed: false, reason: 'opted_out' };

  // Lifecycle nudges are once-per-user-ever. Checked against the log (not
  // the 7-day window below), so a user who got it 3 weeks ago never gets it
  // again, and a double-run of the sweep cannot double-send.
  if (LIFECYCLE_TYPES.includes(type)) {
    const already = await prisma.nudgeLog.findFirst({ where: { userId, type } });
    if (already) return { allowed: false, reason: 'already_sent' };
  }
  if (opts.sameTypeCooldownDays) {
    const since = new Date(now.getTime() - opts.sameTypeCooldownDays * DAY_MS);
    const last = await prisma.nudgeLog.findFirst({ where: { userId, type, sentAt: { gte: since } } });
    if (last) return { allowed: false, reason: 'type_cooldown' };
  }

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recent = await prisma.nudgeLog.findMany({
    where: { userId, sentAt: { gte: weekAgo } },
    orderBy: { sentAt: 'desc' },
  });

  // The weekly cap counts EVERY type, not each in isolation: three
  // different reminders in a week is still three notifications to the
  // person receiving them.
  if (recent.length >= MAX_PER_WEEK) return { allowed: false, reason: 'weekly_cap' };

  const lastSent = recent[0];
  if (lastSent) {
    const hoursSince = (now.getTime() - lastSent.sentAt.getTime()) / (60 * 60 * 1000);
    if (hoursSince < MIN_GAP_HOURS) return { allowed: false, reason: 'too_soon' };
  }

  // The extra floor for `target` above. `recent` spans a week and
  // TARGET_MIN_GAP_HOURS is 72, so a target nudge inside its own cooldown is
  // always in this list - no second query needed.
  if (type === 'target') {
    const lastTarget = recent.find((l) => l.type === 'target');
    if (lastTarget) {
      const hours = (now.getTime() - lastTarget.sentAt.getTime()) / (60 * 60 * 1000);
      if (hours < TARGET_MIN_GAP_HOURS) return { allowed: false, reason: 'target_cooldown' };
    }
  }

  return { allowed: true };
}

const COPY = {
  // Straight from the PRD's copy bank. Never shaming, never a streak
  // threat, and it names the cost (5 seconds) because that is the promise.
  log: {
    title: 'Log today\'s session',
    body: 'Takes about 5 seconds - what did you train?',
    route: 'quick_log',
  },
  comeback: {
    title: 'Missed you for a bit',
    body: 'Plan one session this week?',
    route: 'book',
  },
  // Deliberately no number in the body: this is the user's own goal, and the
  // point is to invite them back to the card that has the number, not to
  // deliver a verdict on a lock screen. "Slip" keeps it a fact about the pace
  // rather than a judgement on the person, matching the tone the card itself
  // uses for the `behind` band.
  target: {
    title: 'A little behind on your goal',
    body: 'A couple of good days puts you back on pace.',
    route: 'score',
  },
};

// Lifecycle copy. Several variants per type, picked deterministically from
// the user id so a user always sees the same one (idempotent retries) while
// the population sees a mix. Rules the founder set: low commitment, never
// "go work out", never implies the person failed. English only, like the
// existing nudges: there is no language field on the user server-side, so
// nothing to localise on (see report). Food logging is not offered here: the
// lifecycle nudges stay low-commitment (food is open from day 0 now, but it
// needs consent + a target first). Routes reuse the app's existing keys ('quick_log' =
// health dashboard / Today); an unknown key just opens the app.
const LIFECYCLE_COPY = {
  onboarding_resume: [
    { title: 'Your plan is almost ready', body: 'Pick up where you left off - it takes about a minute.', route: 'open' },
    { title: 'Nearly there', body: 'A couple more answers and your plan is set up for you.', route: 'open' },
  ],
  first_step: [
    { title: 'Your plan for today is ready', body: 'Have a look whenever you feel like it.', route: 'quick_log' },
    { title: 'A glass of water?', body: 'Log one in a tap and your day is underway.', route: 'quick_log' },
    { title: 'How are you feeling today?', body: 'A one-tap check-in. No pressure.', route: 'quick_log' },
  ],
  first_step_followup: [
    { title: 'Start a streak today', body: 'One small thing is enough to begin it.', route: 'quick_log' },
    { title: 'Today\'s plan is waiting', body: 'Tick one easy item - a glass of water counts.', route: 'quick_log' },
  ],
  // The generalised comeback for people who never finished a workout. No
  // workout ask: the workout comeback above says "plan one session".
  comeback_soft: [
    { title: 'Welcome back whenever you are ready', body: 'Today\'s plan is here - a glass of water is a fine start.', route: 'quick_log' },
    { title: 'Your plan is still here', body: 'Take a look when it suits you.', route: 'quick_log' },
  ],
};

function pickCopy(type, variant, userId) {
  const key = variant === 'soft' && type === 'comeback' ? 'comeback_soft' : type;
  const options = LIFECYCLE_COPY[key];
  if (!options) return COPY[type];
  return options[userId % options.length];
}

async function sendService(userId, type, now = new Date(), opts = {}) {
  const { allowed, reason } = await canSendService(userId, type, now, opts);
  if (!allowed) return { sent: false, reason };

  const copy = pickCopy(type, opts.variant, userId);
  const sent = await notifyUser(userId, {
    title: copy.title,
    body: copy.body,
    // Routing keys only - deep-links the app to the exact screen that
    // completes the action (PRD F7), carries nothing about the session.
    data: { type: 'health_nudge', nudge: type, route: copy.route },
  });

  // Logged only when it actually left: recording an unsent nudge would
  // burn the user's weekly budget on a notification they never saw.
  if (!sent) return { sent: false, reason: 'no_token' };
  await prisma.nudgeLog.create({ data: { userId, type } });

  // Server analytics. Props are the nudge kind and age only - never copy,
  // never anything the user logged.
  try {
    const props = { nudge_type: type };
    if (opts.variant) props.variant = opts.variant;
    if (opts.signupAt) {
      props.hours_since_signup = Math.max(0, Math.floor((now.getTime() - new Date(opts.signupAt).getTime()) / HOUR_MS));
    }
    track('nudge_sent', userId, props);
  } catch {
    // Telemetry never decides whether a nudge counts as sent.
  }
  return { sent: true };
}

/// The whole sweep, called by a scheduled workflow. Returns counts rather
/// than user ids: this runs unattended and its output lands in CI logs.
export async function runNudgeSweepService(now = new Date()) {
  if (isQuietHours(now)) {
    return { skipped: 'quiet_hours', localHour: localHour(now), sent: 0 };
  }

  const results = { log: 0, comeback: 0, target: 0, suppressed: 0, deferred: 0, sent: 0 };

  const unlogged = await findUnloggedUsersService({
    minMinutesSince: LOG_NUDGE_AFTER_MINUTES,
    maxHours: LOG_NUDGE_WINDOW_HOURS,
  });
  for (const candidate of unlogged) {
    const result = await sendService(candidate.userId, 'log', now);
    if (result.sent) {
      results.log += 1;
    } else {
      results.suppressed += 1;
    }
  }

  for (const userId of await findComebackCandidatesService(now)) {
    // Only the comeback nudge is timed to free time. The log nudge is a
    // reaction to a check-in 90 minutes ago — delaying it to the evening
    // would ask about a session the user has half forgotten. A comeback has
    // no such clock, so it waits for a run inside their window; skipping here
    // costs nothing from the weekly budget, and the next in-window run picks
    // them up. Best-effort read: an unreachable auth-service means "no
    // preference", not "no nudge".
    const profile = await fetchUserProfileInternal(userId);
    // Candidates come from workout history. Someone who has since switched to
    // wellness stopped working out on purpose; "come back" is the wrong push.
    if (isWellnessProfile(profile)) {
      results.suppressed += 1;
      continue;
    }
    if (!isWithinFreeTime(profile?.freeTimeWindow, now)) {
      results.deferred += 1;
      continue;
    }
    const result = await sendService(userId, 'comeback', now);
    if (result.sent) {
      results.comeback += 1;
    } else {
      results.suppressed += 1;
    }
  }

  for (const userId of await findTargetCandidatesService(now)) {
    // Like the comeback nudge, this has no clock of its own, so it waits for a
    // run inside the user's free-time window rather than interrupting a
    // morning they are busy in. Deferring costs nothing from the budget; the
    // next in-window run picks them up.
    const profile = await fetchUserProfileInternal(userId);
    if (!isWithinFreeTime(profile?.freeTimeWindow, now)) {
      results.deferred += 1;
      continue;
    }
    const result = await sendService(userId, 'target', now);
    if (result.sent) {
      results.target += 1;
    } else {
      results.suppressed += 1;
    }
  }

  const lifecycle = await runLifecycleSweep(now);
  Object.assign(results, {
    onboarding_resume: lifecycle.onboarding_resume,
    first_step: lifecycle.first_step,
    first_step_followup: lifecycle.first_step_followup,
    comeback_soft: lifecycle.comeback_soft,
    lifecycle_no_token: lifecycle.no_token,
    lifecycle_coverage: lifecycle.coverage,
  });
  results.suppressed += lifecycle.suppressed;
  results.deferred += lifecycle.deferred;

  results.sent =
    results.log + results.comeback + results.target +
    lifecycle.onboarding_resume + lifecycle.first_step +
    lifecycle.first_step_followup + lifecycle.comeback_soft;
  return results;
}

/// Which lifecycle nudge, if any, a recent signup is due, from age and
/// activity alone (no sending rules - caps, quiet hours and opt-outs are
/// applied afterwards). Pure so the timing table is testable without a
/// database.
///
/// candidate:  { createdAt, onboardingComplete }
/// activity:   { last: Date|null, completedWorkout: boolean } - `last` is the
///             most recent of any water/food/workout/plan-tick/mood row.
///
/// Returns { type, variant? } or null.
///
/// Onboarding completion has no timestamp server-side, so signup time stands
/// in for it: leavers quit about a minute after finishing onboarding, so the
/// difference is noise next to the 24h/72h thresholds.
export function lifecycleStageFor(candidate, activity, now = new Date()) {
  const ageHours = (now.getTime() - new Date(candidate.createdAt).getTime()) / HOUR_MS;

  if (!candidate.onboardingComplete) {
    return ageHours >= RESUME_FROM_HOURS && ageHours < RESUME_UNTIL_HOURS
      ? { type: 'onboarding_resume' }
      : null;
  }

  // Finished a workout once: the existing comeback owns them.
  if (activity.completedWorkout) return null;

  if (!activity.last) {
    if (ageHours >= FIRST_STEP_FROM_HOURS && ageHours < FIRST_STEP_UNTIL_HOURS) return { type: 'first_step' };
    if (ageHours >= FIRST_STEP_UNTIL_HOURS && ageHours < FOLLOWUP_UNTIL_HOURS) return { type: 'first_step_followup' };
    // Never did anything and past the first week: anchor on signup. Same
    // 7-day floor and 60-day churn ceiling as the workout comeback.
    if (ageHours >= COMEBACK_AFTER_DAYS * 24 && ageHours < COMEBACK_UNTIL_DAYS * 24) {
      return { type: 'comeback', variant: 'soft' };
    }
    return null;
  }

  const quietDays = (now.getTime() - new Date(activity.last).getTime()) / DAY_MS;
  if (quietDays >= COMEBACK_AFTER_DAYS && quietDays < COMEBACK_UNTIL_DAYS) {
    return { type: 'comeback', variant: 'soft' };
  }
  return null;
}

/// Most recent activity of any kind, and whether a workout was ever
/// completed, for a batch of users. Grouped in SQL, one query per source.
export async function findLifecycleActivityService(userIds) {
  const result = new Map(userIds.map((id) => [id, { last: null, completedWorkout: false }]));
  if (!userIds.length) return result;
  const where = { userId: { in: userIds } };
  const bump = (rows, field) => {
    for (const row of rows) {
      const at = row._max?.[field];
      const entry = result.get(row.userId);
      if (at && entry && (!entry.last || at > entry.last)) entry.last = at;
    }
  };
  bump(await prisma.waterLog.groupBy({ by: ['userId'], where, _max: { createdAt: true } }), 'createdAt');
  bump(await prisma.foodLog.groupBy({ by: ['userId'], where, _max: { createdAt: true } }), 'createdAt');
  bump(await prisma.planItemCompletion.groupBy({ by: ['userId'], where, _max: { createdAt: true } }), 'createdAt');
  bump(await prisma.wellnessMoodCheckIn.groupBy({ by: ['userId'], where, _max: { createdAt: true } }), 'createdAt');
  bump(await prisma.workoutSession.groupBy({ by: ['userId'], where, _max: { startedAt: true } }), 'startedAt');
  const finished = await prisma.workoutSession.groupBy({
    by: ['userId'],
    where: { ...where, endedAt: { not: null } },
    _max: { startedAt: true },
  });
  for (const row of finished) {
    const entry = result.get(row.userId);
    if (entry) entry.completedWorkout = true;
  }
  return result;
}

/// The lifecycle half of the sweep. Every send still goes through
/// sendService, so quiet hours (checked by the caller), the weekly cap, the
/// 24h gap, opt-outs and once-ever idempotency all apply.
///
/// A user with no registered FCM token is counted in `no_token` and skipped
/// BEFORE sending, so the number says how many people we would have nudged
/// but cannot reach. `coverage` is the token coverage across every recent
/// signup the sweep saw, read straight from the run log.
export async function runLifecycleSweep(now = new Date()) {
  const out = {
    onboarding_resume: 0, first_step: 0, first_step_followup: 0, comeback_soft: 0,
    no_token: 0, suppressed: 0, deferred: 0,
    coverage: { candidates: 0, withToken: 0, onboarded: 0, onboardedWithToken: 0 },
  };

  const candidates = await fetchLifecycleCandidates({
    createdBefore: new Date(now.getTime() - RESUME_FROM_HOURS * HOUR_MS),
  });
  for (const c of candidates) {
    out.coverage.candidates += 1;
    if (c.hasToken) out.coverage.withToken += 1;
    if (c.onboardingComplete) {
      out.coverage.onboarded += 1;
      if (c.hasToken) out.coverage.onboardedWithToken += 1;
    }
  }

  // Activity only matters for people who finished onboarding.
  const activity = await findLifecycleActivityService(
    candidates.filter((c) => c.onboardingComplete).map((c) => c.id),
  );

  for (const c of candidates) {
    const stage = lifecycleStageFor(
      c,
      activity.get(c.id) ?? { last: null, completedWorkout: false },
      now,
    );
    if (!stage) continue;

    if (!c.hasToken) {
      out.no_token += 1;
      continue;
    }
    // The resume nudge goes to someone who has not told us when they are
    // free yet; the rest wait for a sweep inside their window. Deferring
    // costs nothing - the stage windows are wide enough to span several runs.
    if (stage.type !== 'onboarding_resume' && !isWithinFreeTime(c.freeTimeWindow, now)) {
      out.deferred += 1;
      continue;
    }

    const opts = { signupAt: c.createdAt, variant: stage.variant };
    if (stage.variant === 'soft') opts.sameTypeCooldownDays = SOFT_COMEBACK_COOLDOWN_DAYS;
    const result = await sendService(c.id, stage.type, now, opts);
    if (result.sent) {
      out[stage.variant === 'soft' ? 'comeback_soft' : stage.type] += 1;
    } else if (result.reason === 'no_token') {
      out.no_token += 1;
    } else {
      out.suppressed += 1;
    }
  }

  if (out.no_token > 0) {
    console.log(`[nudge] lifecycle skipped reason=no_token count=${out.no_token}`);
  }
  return out;
}

/// Users who have logged before and have gone quiet. Grouped in SQL rather
/// than pulled into memory - this is the one query here that scans across
/// all users.
export async function findComebackCandidatesService(now = new Date()) {
  const quietSince = new Date(now.getTime() - COMEBACK_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const churnedBefore = new Date(now.getTime() - COMEBACK_UNTIL_DAYS * 24 * 60 * 60 * 1000);

  const grouped = await prisma.workoutSession.groupBy({
    by: ['userId'],
    where: { endedAt: { not: null } },
    _max: { startedAt: true },
  });

  return grouped
    .filter((row) => {
      const last = row._max.startedAt;
      return last && last < quietSince && last > churnedBefore;
    })
    .map((row) => row.userId);
}

/// Whether a pause is covering `today`. A paused user has been told to stop;
/// the score is frozen on purpose, so "you are behind" would be telling them
/// off for the rest they were just told to take.
function isPausedToday(goal, today) {
  return (
    goal.pausedFrom != null &&
    goal.pausedUntil != null &&
    goal.pausedFrom <= today &&
    today <= goal.pausedUntil
  );
}

/// Users holding a live score target, before any judgement about their pace.
///
/// Split from [findTargetCandidatesService] so the half that is SQL can be
/// tested against a real database: the interesting part of this query is that
/// `scoreTargetUntil` is TEXT holding 'YYYY-MM-DD' and is compared with `gte`,
/// which is exactly the kind of thing a hand-written mock agrees with by
/// construction. Being behind is a band, and bands are the engine's business.
export async function findTargetGoalRowsService(now = new Date()) {
  const today = localDateIST(now);

  const goals = await prisma.healthGoal.findMany({
    where: {
      scoreTargetPoints: { not: null },
      scoreTargetUntil: { gte: today },
      calmMode: false,
    },
    select: {
      userId: true,
      scoreTargetFrom: true,
      pausedFrom: true,
      pausedUntil: true,
    },
  });

  return goals.filter(
    (goal) => !(goal.scoreTargetFrom && goal.scoreTargetFrom > today) && !isPausedToday(goal, today),
  );
}

/// Users with a live score target who are behind pace on it.
///
/// This is the one nudge the user opted into by setting a target at all - the
/// reminder is of a number they chose, not one the app invented. It is
/// deliberately silent for `at_risk`: that band exists so the card can be
/// honestly amber, not so a phone can buzz on the first slightly-off day.
/// Waiting for `behind` (the narrower band) means the message arrives when
/// there is something real to catch up on, which is what makes it worth
/// sending at all.
///
/// `calmMode` is excluded in SQL, not filtered afterwards: calm mode is the
/// thing that flattens the card to one line with no red, and a push that says
/// "behind" would undo exactly what the user asked for. A query that never
/// retrieves them cannot nudge them. `reached`/`expired` fall out of the band
/// check.
export async function findTargetCandidatesService(now = new Date()) {
  const today = localDateIST(now);

  const out = [];
  for (const goal of await findTargetGoalRowsService(now)) {
    // The same computation the card runs, so "behind" here cannot disagree
    // with the band the user sees when they tap through.
    const state = await getScoreTargetState(prisma, { userId: goal.userId, today });
    if (state.band === 'behind') out.push(goal.userId);
  }
  return out;
}

export async function getOptOutsService(userId) {
  const rows = await prisma.nudgeOptOut.findMany({ where: { userId } });
  return rows.map((r) => r.type);
}

export async function setOptOutService(userId, type, optedOut) {
  if (!OPT_OUT_TYPES.includes(type)) {
    const err = new Error(`type must be one of: ${OPT_OUT_TYPES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (optedOut) {
    await prisma.nudgeOptOut.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type },
      update: {},
    });
  } else {
    await prisma.nudgeOptOut.deleteMany({ where: { userId, type } });
  }
  return getOptOutsService(userId);
}
