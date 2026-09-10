import { PrismaClient } from '@prisma/client';

import { notifyUser } from '../utils/notifyUser.js';
import { findUnloggedUsersService } from './unloggedService.js';

const prisma = new PrismaClient();

// FR-08. Two nudges, both earned by something the user actually did:
//
//   log      - attended, and 90 minutes later still hasn't said what they did
//   comeback - has logged before, and nothing for 7 days
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
export const NUDGE_TYPES = ['log', 'comeback'];

// PRD S7.4: max 3 a week, never two within 24 hours, quiet 22:00-09:00.
export const MAX_PER_WEEK = 3;
export const MIN_GAP_HOURS = 24;
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 9;

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

  const results = { log: 0, comeback: 0, suppressed: 0, sent: 0 };

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
    const result = await sendService(userId, 'comeback', now);
    if (result.sent) {
      results.comeback += 1;
    } else {
      results.suppressed += 1;
    }
  }

  results.sent = results.log + results.comeback;
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
