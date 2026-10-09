import { PrismaClient } from '@prisma/client';
import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';
import {
  startOfIsoWeek, addDays, dayString, dayToDate, COUNTED_WORKOUT_WHERE,
} from '../utils/sessionDay.js';

// Re-exported for the sibling readers (stats, consistency streak) that have
// always imported their week boundary from here, so there is exactly one
// definition and the Monday boundary can never drift between them.
export { startOfIsoWeek } from '../utils/sessionDay.js';

const prisma = new PrismaClient();

// FR-04. One weekly session target per user, and the week's progress against
// it, resolved server-side so the ring, the export and any future stats
// endpoint can never disagree about what "this week" means.
//
// Range: one session a week is a real goal for someone starting out, and
// two-a-days exist, so 14 is the ceiling rather than 7. Above that it stops
// being a target and starts being a typo.
export const MIN_SESSIONS_PER_WEEK = 1;
export const MAX_SESSIONS_PER_WEEK = 14;

// Used when a user has no stated intent and hasn't chosen: three is the
// midpoint of the onboarding options and matches the qualifying-checkins
// cadence challenge-service already rewards.
export const NEUTRAL_DEFAULT = 3;

// auth-service's FrequencyIntent -> a number of sessions. Each maps to the
// LOW end of its band on purpose: a goal you clear is the one you keep, and
// the product's own copy offers to re-plan a missed goal downward rather
// than talk someone into a bigger one.
const INTENT_TO_SESSIONS = {
  one_two: 2,
  three_four: 3,
  five_plus: 5,
};

// The Monday-start week boundary lives in utils/sessionDay.js (IST-anchored),
// shared with challenge-service's copy so the goal week and the streak week
// are the same week. They're separate services with no shared code, so the
// boundary is duplicated-but-identical on purpose: a ring that resets on a
// different day from the streak it sits next to is a bug report waiting to
// happen.

/// Resolves the user's target, persisting a derived one the first time so
/// the number doesn't move under them between renders.
export async function resolveGoalService(userId) {
  const existing = await prisma.weeklyGoal.findUnique({ where: { userId } });
  if (existing) {
    return {
      sessionsPerWeek: existing.sessionsPerWeek,
      source: existing.setByUser ? 'user' : 'onboarding',
    };
  }

  const profile = await fetchUserProfileInternal(userId);
  const derived = INTENT_TO_SESSIONS[profile?.weeklyFrequencyIntent];
  const sessionsPerWeek = derived ?? NEUTRAL_DEFAULT;

  // Persisted even when derived, so a later change to onboarding intent
  // doesn't silently move a target the user has been measuring against —
  // and so a transient auth-service failure can't hand them a different
  // number on the next render.
  await prisma.weeklyGoal.create({
    data: { userId, sessionsPerWeek, setByUser: false },
  });

  return {
    sessionsPerWeek,
    source: derived ? 'onboarding' : 'default',
  };
}

export async function setGoalService(userId, sessionsPerWeek) {
  const value = Number(sessionsPerWeek);
  if (!Number.isInteger(value) || value < MIN_SESSIONS_PER_WEEK || value > MAX_SESSIONS_PER_WEEK) {
    const err = new Error(
      `sessionsPerWeek must be an integer between ${MIN_SESSIONS_PER_WEEK} and ${MAX_SESSIONS_PER_WEEK}`,
    );
    err.status = 400;
    throw err;
  }

  await prisma.weeklyGoal.upsert({
    where: { userId },
    create: { userId, sessionsPerWeek: value, setByUser: true },
    update: { sessionsPerWeek: value, setByUser: true },
  });

  return { sessionsPerWeek: value, source: 'user' };
}

// Counts counted workout sessions (see COUNTED_WORKOUT_WHERE: finished,
// non-rest, at least one completed set) per IST week over the last three
// weeks in a single query. The empty-set and rest exclusions are what let
// the home ring, the stats KPI and the streak report the same number.
//
// Keyed on localDate — the day the user experienced — rather than startedAt,
// so a session logged just after midnight or backfilled while travelling
// lands in the week they'd expect. Sessions predating the localDate column
// fall back to startedAt so old history isn't silently dropped from the
// count.
async function weeklyCountsService(userId, weeks = 3) {
  const thisWeekStart = startOfIsoWeek();
  const windowStart = addDays(thisWeekStart, -7 * (weeks - 1));

  const sessions = await prisma.workoutSession.findMany({
    where: {
      userId,
      ...COUNTED_WORKOUT_WHERE,
      OR: [
        { localDate: { gte: dayString(windowStart) } },
        { AND: [{ localDate: null }, { startedAt: { gte: windowStart } }] },
      ],
    },
    select: { localDate: true, startedAt: true },
  });

  const counts = new Map();
  for (let i = 0; i < weeks; i++) {
    counts.set(dayString(addDays(windowStart, i * 7)), 0);
  }

  for (const session of sessions) {
    const day = session.localDate
      ? dayToDate(session.localDate)
      : session.startedAt;
    const key = dayString(startOfIsoWeek(day));
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }

  return { thisWeekStart, counts };
}

/// The whole payload the home ring needs: target, progress, and whether the
/// last two COMPLETE weeks both fell short — which is the only trigger for
/// offering to re-plan the goal downward (FR-17). Two weeks, not one: a
/// single missed week is a week, not a pattern, and offering to lower
/// someone's goal after one bad week would be its own kind of discouraging.
export async function getGoalStateService(userId) {
  const [goal, { thisWeekStart, counts }] = await Promise.all([
    resolveGoalService(userId),
    weeklyCountsService(userId, 3),
  ]);

  const weekStart = dayString(thisWeekStart);
  const completedThisWeek = counts.get(weekStart) ?? 0;
  const previousWeeks = [...counts.entries()]
    .filter(([key]) => key !== weekStart)
    .map(([weekStart, completed]) => ({ weekStart, completed }));

  const shortfallStreak = previousWeeks.every((w) => w.completed < goal.sessionsPerWeek);

  return {
    sessionsPerWeek: goal.sessionsPerWeek,
    source: goal.source,
    weekStart,
    completedThisWeek,
    remaining: Math.max(0, goal.sessionsPerWeek - completedThisWeek),
    previousWeeks,
    // Only meaningful once there are two complete weeks of history to judge;
    // a brand-new account has previousWeeks all zero and would otherwise be
    // offered a smaller goal before its first session.
    suggestReplan: shortfallStreak && previousWeeks.some((w) => w.completed > 0),
    min: MIN_SESSIONS_PER_WEEK,
    max: MAX_SESSIONS_PER_WEEK,
  };
}
