import redis from '../../utils/redisClient.js';
import { createTtlCache } from '../../utils/ttlCache.js';
import { onJourneyInvalidate } from '../../utils/journeyCacheBus.js';

// In-process layer in front of the Redis path (Redis is absent where there is
// no REDIS_URL, which made the Redis-only cache a silent no-op). Per instance and
// short on purpose; every existing invalidation point goes through
// invalidateBlendedScore below, so they evict this too.
export const BLENDED_MEMO_TTL_MS = 60_000;
export const blendedMemo = createTtlCache({ ttlMs: BLENDED_MEMO_TTL_MS, maxEntries: 2000 });
onJourneyInvalidate((userId) => blendedMemo.invalidate(String(userId)));

// The blended Health Score is cached for an hour (scoreService). Without this,
// confirming a lab value or typing a body number left the card showing the old
// score for up to that hour - the one moment a user is most likely to look.
export const blendedScoreCacheKey = (userId) => `health:blended:${userId}`;

// Best-effort: the cache is an optimisation, so a failed delete must never fail
// the write that triggered it. The worst case is the hour-old score above.
export async function invalidateBlendedScore(userId) {
  blendedMemo.invalidate(String(userId));
  try {
    await redis.del(blendedScoreCacheKey(userId));
  } catch (err) {
    console.error('[blended-score] cache invalidation failed:', err?.message);
  }
}
