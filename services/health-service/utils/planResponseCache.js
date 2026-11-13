/**
 * Short-lived, per-instance response cache for GET /plan/today.
 *
 * /plan/today rebuilds ~9-11 Neon round trips on every call even when every
 * inner cache (journey, showed-up-days) is warm, because getSessions, layers
 * and resolveDay all re-read the DB per request. This cache holds the assembled
 * payload per (user, localDate) for a short TTL so a user tapping in and out of
 * the plan screen hits memory instead of the database.
 *
 * It is an optimisation, never load-bearing for correctness: each Cloud Run
 * instance has its own copy, TTLs are short, and every write path the service
 * owns (plan item mutations) plus the journey invalidation bus evicts entries.
 *
 * Under `node --test` (NODE_TEST_CONTEXT) the underlying TTL cache is disabled,
 * so unit tests always run the loader.
 */

import { createTtlCache } from './ttlCache.js';
import { onJourneyInvalidate } from './journeyCacheBus.js';

const PLAN_TODAY_TTL_MS =
  Number(process.env.PLAN_TODAY_RESPONSE_CACHE_TTL_MS ?? 15_000);

const planTodayCache = createTtlCache({ ttlMs: PLAN_TODAY_TTL_MS });

export function planTodayCacheKey(userId, localDate) {
  return `${Number(userId)}|${localDate ?? 'today'}`;
}

/**
 * Get the cached /plan/today payload, or run `loader` and store it.
 */
export async function getPlanToday(userId, localDate, loader) {
  return planTodayCache.get(planTodayCacheKey(userId, localDate), loader);
}

/**
 * Replace the cached payload for (user, localDate). Call this from write paths
 * after they rebuild today so a subsequent GET /plan/today is fresh immediately.
 */
export function setPlanToday(userId, localDate, value) {
  planTodayCache.store(planTodayCacheKey(userId, localDate), value);
}

/**
 * Drop the cached payload for (user, localDate).
 */
export function invalidatePlanToday(userId, localDate) {
  planTodayCache.invalidate(planTodayCacheKey(userId, localDate));
}

/**
 * Drop every cached today-payload for `userId` (any date). Called from the
 * journey invalidation bus so a workout finish / consent erase can't leave a
 * stale today payload sitting in this instance's cache.
 */
onJourneyInvalidate((userId) => {
  planTodayCache.invalidateKeysStartingWith(`${Number(userId)}|`);
});
