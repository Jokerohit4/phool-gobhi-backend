import { createTtlCache } from './ttlCache.js';

// Short (15s) per-enrollment cache of the health-service activity count that
// refreshPersonalChallenge fetches on every list call.
//
// Safety model (see test/personalProgressCache.test.js):
// - The cached value is only the raw count READ from health-service. Completion
//   and reward still run through the idempotent path (ledger key
//   `challenge-reward:<enrollmentId>` + rewardIssuance upsert), so a stale or
//   repeated count can delay completion by at most the TTL, never advance it
//   early and never pay twice.
// - The key carries userId + enrollmentId + enrollment start time, so a count
//   read for one enrollment (or an earlier start of the same one) is never
//   served to another.
// - Failures are never cached (ttlCache), concurrent reads single-flight.
// - Join / leave / erasure evict (by user), see challengeEnrollmentService.js.
// - Off under node --test unless CHALLENGE_CACHE_FORCE=1 (ttlCache convention).
// Per-instance only: a count logged on health-service can take up to 15s to show.
const MAX_KEYS = 5000; // memory bound: ttlCache never drops expired entries on its own
const cache = createTtlCache(15_000);
const keysByUser = new Map(); // userId -> Set(key)
let tracked = 0;

export function progressKey(userId, enrollment) {
  return `${userId}:${enrollment.id}:${new Date(enrollment.startedAt).getTime()}`;
}

export function getCachedProgress(userId, enrollment, loader) {
  const key = progressKey(userId, enrollment);
  if (tracked >= MAX_KEYS) clearPersonalProgressCache();
  let set = keysByUser.get(userId);
  if (!set) keysByUser.set(userId, (set = new Set()));
  if (!set.has(key)) { set.add(key); tracked++; }
  return cache.get(key, loader);
}

// Drop every cached/in-flight count for a user (join, leave, erasure).
export function evictPersonalProgress(userId) {
  const set = keysByUser.get(userId);
  if (!set) return;
  for (const key of set) cache.evict(key);
  tracked -= set.size;
  keysByUser.delete(userId);
}

export function clearPersonalProgressCache() {
  cache.clear();
  keysByUser.clear();
  tracked = 0;
}
