import { PrismaClient } from '@prisma/client';
import { startOfIsoWeek } from './goalService.js';

const prisma = new PrismaClient();

// The home-track streak. Deliberately NOT the same thing as
// challenge-service's UserStreak/UserStreakWeek, and deliberately not
// connected to it.
//
//   UserStreakWeek  — built from verified AttendanceEventLog rows (GPS/QR
//                     check-in at a partner gym). Pays coins and milestones,
//                     so it has to be unfakeable and server-authoritative.
//   this file       — built from the user's own WorkoutSession rows, logged
//                     anywhere including at home. Pays NOTHING: no coins, no
//                     milestone credit, no redeemable of any kind.
//
// The reason for the split (decision D-01, docs/../sprint2/PG-HUNT-001):
// a coin redeems for a real Rs 300-600 gym trial pass, so crediting coins
// for a self-reported tap would turn a button into money — and with the
// trial inventory capped monthly, farmed coins wouldn't just cost rupees,
// they'd consume passes meant for real gym-curious users. So self-reported
// logs mint no currency.
//
// But a home-only user still needs to see their own consistency, or they
// have no progress surface at all — no number, no ring, no reason to open
// the app on a rest day. A streak that buys nothing is safe to be generous
// with, which is exactly why it can be computed from unverifiable data.
//
// This service lives in health-service, NOT challenge-service, on purpose:
// it must be structurally impossible for this number to reach the coin
// ledger. There is no import path from here to it.

// A week counts if the user logged at least this many sessions in it.
//
// Mirrors challenge-service's CoinEconomyConfig.qualifyingCheckinsPerWeek
// default (2) so the two streaks a user sees side by side mean the same
// cadence. NOT read from that config and NOT admin-editable here: this
// number never moves money, so it doesn't need a settings row, and one
// fewer cross-service call on a home-screen render is worth more than the
// flexibility. If an admin ever changes the coin-side value, the two will
// silently diverge — that's a decision to make deliberately, not a setting
// to drift.
export const QUALIFYING_SESSIONS_PER_WEEK = 2;

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addWeeks(date, weeks) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d;
}

// Deliberately derived on read rather than kept in a table.
//
// The coin-bearing streak is persisted because it must be auditable and
// append-only. This one is a pure function of rows we already have, so a
// cached copy could only ever be a second source of truth that drifts —
// and it would need its own erasure and export handling for data that is
// already covered by the sessions it's derived from. goalService already
// sets this precedent with weeklyCountsService.
//
// Cost: one indexed query returning two small columns. A user four years
// in at four sessions a week is ~800 rows, and the whole history is needed
// anyway for an all-time record that must never go down.
async function qualifyingWeeksService(userId) {
  const sessions = await prisma.workoutSession.findMany({
    where: {
      userId,
      endedAt: { not: null },
      NOT: { type: 'rest' },
    },
    select: { localDate: true, startedAt: true },
  });

  // Keyed on localDate — the day the user experienced — with a startedAt
  // fallback for sessions that predate that column, same rule goalService
  // uses so a session can't land in one week for the ring and another for
  // the streak.
  const perWeek = new Map();
  for (const session of sessions) {
    const day = session.localDate
      ? new Date(`${session.localDate}T00:00:00Z`)
      : session.startedAt;
    const key = toDateKey(startOfIsoWeek(day));
    perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
  }

  const qualifying = new Set();
  for (const [week, count] of perWeek.entries()) {
    if (count >= QUALIFYING_SESSIONS_PER_WEEK) qualifying.add(week);
  }

  return { perWeek, qualifying, sessionsLogged: sessions.length };
}

// Walks back from the current week to find the live run.
//
// The in-progress week is counted only once it has actually qualified, but a
// week that hasn't qualified YET does not break the run — someone on a
// Wednesday with one session logged still has until Sunday. Breaking a
// streak mid-week would punish people for the calendar, which inverts the
// product's own rule that charts celebrate consistency and never shame gaps.
function currentRun(qualifying, thisWeekStart) {
  const thisWeekQualified = qualifying.has(toDateKey(thisWeekStart));

  // Start counting at this week if it already qualified, otherwise at last
  // week — leaving the current, unfinished week neutral.
  let cursor = thisWeekQualified ? thisWeekStart : addWeeks(thisWeekStart, -1);
  let weeks = 0;

  while (qualifying.has(toDateKey(cursor))) {
    weeks += 1;
    cursor = addWeeks(cursor, -1);
  }

  return { weeks, thisWeekQualified };
}

// Longest run over all history. Computed from the full set rather than a
// window so an all-time record can never decrease — a "best ever" number
// that quietly drops is worse than not showing one.
function longestRun(qualifying) {
  let longest = 0;

  for (const week of qualifying) {
    // Only start counting from the beginning of a run, so each run is
    // walked once instead of once per week it contains.
    const previous = toDateKey(addWeeks(new Date(`${week}T00:00:00Z`), -1));
    if (qualifying.has(previous)) continue;

    let length = 0;
    let cursor = new Date(`${week}T00:00:00Z`);
    while (qualifying.has(toDateKey(cursor))) {
      length += 1;
      cursor = addWeeks(cursor, 1);
    }
    if (length > longest) longest = length;
  }

  return longest;
}

/// Everything the home-track streak surface needs, in one call.
///
/// `weeksToShow` of recent history comes back too, so the client can draw a
/// small week strip without a second request and without deriving weeks
/// itself (the client deriving "this week" is how the ring and the streak
/// end up disagreeing).
export async function getConsistencyStreakService(userId, { weeksToShow = 12 } = {}) {
  const { perWeek, qualifying, sessionsLogged } = await qualifyingWeeksService(userId);
  const thisWeekStart = startOfIsoWeek();

  const { weeks, thisWeekQualified } = currentRun(qualifying, thisWeekStart);

  const recentWeeks = [];
  for (let i = weeksToShow - 1; i >= 0; i--) {
    const weekStart = toDateKey(addWeeks(thisWeekStart, -i));
    recentWeeks.push({
      weekStart,
      sessions: perWeek.get(weekStart) ?? 0,
      qualified: qualifying.has(weekStart),
    });
  }

  return {
    currentWeeks: weeks,
    longestWeeks: Math.max(longestRun(qualifying), weeks),
    sessionsLogged,
    thisWeekSessions: perWeek.get(toDateKey(thisWeekStart)) ?? 0,
    thisWeekQualified,
    qualifyingSessionsPerWeek: QUALIFYING_SESSIONS_PER_WEEK,
    weekStart: toDateKey(thisWeekStart),
    recentWeeks,
    // Says out loud what this number is, so no client can accidentally
    // present it as the verified streak or hang a reward off it.
    verified: false,
    earnsCoins: false,
  };
}
