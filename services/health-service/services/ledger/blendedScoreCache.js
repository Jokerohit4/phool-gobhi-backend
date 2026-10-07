import redis from '../../utils/redisClient.js';

// The blended Health Score is cached for an hour (scoreService). Without this,
// confirming a lab value or typing a body number left the card showing the old
// score for up to that hour - the one moment a user is most likely to look.
export const blendedScoreCacheKey = (userId) => `health:blended:${userId}`;

// Best-effort: the cache is an optimisation, so a failed delete must never fail
// the write that triggered it. The worst case is the hour-old score above.
export async function invalidateBlendedScore(userId) {
  try {
    await redis.del(blendedScoreCacheKey(userId));
  } catch (err) {
    console.error('[blended-score] cache invalidation failed:', err?.message);
  }
}
