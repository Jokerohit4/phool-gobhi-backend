import { PrismaClient } from '@prisma/client';
import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';

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

// Monday-start, UTC — identical to challenge-service's startOfIsoWeek, so
// the goal week and the streak week are the same week. They're separate
// implementations because they're separate services, but they must not
// drift: a ring that resets on a different day from the streak it sits next
// to is a bug report waiting to happen.
export function startOfIsoWeek(date = new Date()) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function toLocalDateString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

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

// Counts finished, non-rest sessions per ISO week over the last three weeks
// (this one plus the two before it) in a single query.
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
      endedAt: { not: null },
      NOT: { type: 'rest' },
      OR: [
        { localDate: { gte: toLocalDateString(windowStart) } },
        { AND: [{ localDate: null }, { startedAt: { gte: windowStart } }] },
      ],
    },
    select: { localDate: true, startedAt: true },
  });

  const counts = new Map();
  for (let i = 0; i < weeks; i++) {
    counts.set(toLocalDateString(addDays(windowStart, i * 7)), 0);
  }

  for (const session of sessions) {
    const day = session.localDate
      ? new Date(`${session.localDate}T00:00:00Z`)
      : session.startedAt;
    const key = toLocalDateString(startOfIsoWeek(day));
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

  const weekStart = toLocalDateString(thisWeekStart);
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
