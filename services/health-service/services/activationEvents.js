import { track } from '../utils/analytics.js';

// Activation milestones: each fires once per user, the first time the action is
// persisted. "First" is read from the rows that already exist, so there is no
// new table or migration. The probe runs BEFORE the write and the event goes out
// AFTER it succeeds, so a failed write never reports an activation.
//
// Properties are enums or counts only. Never a food name, meal content, or any
// other description of what the user ate.
//
// Known limit: a user who deletes their ONLY row and logs again looks "first"
// again and fires a second time. Reports must therefore count distinct users,
// which is how every funnel here is built anyway.

const NOOP = { emit() {} };

async function probe(findAny, event, build) {
  let isFirst = false;
  try {
    isFirst = (await findAny()) == null;
  } catch {
    return NOOP; // analytics must never break the user's action
  }
  if (!isFirst) return NOOP;
  return {
    emit(...args) {
      try {
        const props = build(...args);
        if (props) track(event, props.userId, props.properties);
      } catch {
        /* never fail the request over analytics */
      }
    },
  };
}

/** Call before the food write; call `.emit({ loggedCount, source })` after it succeeded. */
export function firstFoodLogProbe(prisma, userId) {
  return probe(
    () => prisma.foodLog.findFirst({ where: { userId }, select: { id: true } }),
    'first_food_logged',
    ({ loggedCount, source } = {}) => {
      // A saved-meal / photo request can legitimately write zero rows.
      if (loggedCount != null && !(Number(loggedCount) > 0)) return null;
      return {
        userId,
        properties: { source: source || null, logged_count: loggedCount == null ? null : Number(loggedCount) },
      };
    },
  );
}

/** Call before the water write; call `.emit({ ml })` after it succeeded. */
export function firstWaterLogProbe(prisma, userId) {
  return probe(
    () => prisma.waterLog.findFirst({ where: { userId }, select: { id: true } }),
    'first_water_logged',
    ({ ml } = {}) => ({ userId, properties: { ml: Number.isFinite(Number(ml)) ? Number(ml) : null } }),
  );
}

/**
 * Call before creating a user-started session; call `.emit({ templateId })` after it was created.
 * Attendance drafts (attendedAt set by the internal check-in route) are not a workout the
 * user started, so they do not count as "already had a workout".
 */
export function firstWorkoutProbe(prisma, userId) {
  return probe(
    () => prisma.workoutSession.findFirst({ where: { userId, attendedAt: null }, select: { id: true } }),
    'first_workout_started',
    ({ templateId } = {}) => ({
      userId,
      // template = started from a saved template or routine; custom = started empty.
      properties: { workout_source: templateId ? 'template' : 'custom' },
    }),
  );
}
