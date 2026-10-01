import { PrismaClient } from '@prisma/client';

import { notifyUser } from '../utils/notifyUser.js';
import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';
import { findUnloggedUsersService } from './unloggedService.js';
import { getScoreTargetState } from './ledger/scoreTargetService.js';

const prisma = new PrismaClient();

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
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(now),
  );
}

export function isQuietHours(now = new Date()) {
  const hour = localHour(now);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/// The IST day `now` falls on, 'YYYY-MM-DD'. The score target's window is
/// expressed in these strings, so picking candidates means comparing the same
/// kind of value the card does. Same one-function reasoning as [localHour].
export function localDateIST(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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
export async function canSendService(userId, type, now = new Date()) {
  const optedOut = await prisma.nudgeOptOut.findUnique({
    where: { userId_type: { userId, type } },
  });
  if (optedOut) return { allowed: false, reason: 'opted_out' };

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

async function sendService(userId, type, now = new Date()) {
  const { allowed, reason } = await canSendService(userId, type, now);
  if (!allowed) return { sent: false, reason };

  const copy = COPY[type];
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

  results.sent = results.log + results.comeback + results.target;
  return results;
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
/// check below.
export async function findTargetCandidatesService(now = new Date()) {
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

  const out = [];
  for (const goal of goals) {
    // A target whose window has not opened yet has nothing to be behind on.
    if (goal.scoreTargetFrom && goal.scoreTargetFrom > today) continue;
    if (isPausedToday(goal, today)) continue;
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
  if (!NUDGE_TYPES.includes(type)) {
    const err = new Error(`type must be one of: ${NUDGE_TYPES.join(', ')}`);
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
