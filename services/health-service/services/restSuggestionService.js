import prisma from '../db/prisma.js';

// The single seam for personalised rest. Callers only ever see
// { seconds, samples, basedOnSessionId } per exercise, so new signals can be
// added to computeSuggestedRest's options without touching them.

export const REST_SAMPLE_MIN = 5;
export const REST_SAMPLE_MAX = 600;
export const REST_SUGGEST_MIN = 20;
export const REST_SUGGEST_MAX = 300;

/**
 * Pure. v1 rule: mean of usable rest samples, clamped and rounded to 5s.
 *
 * @param {object} opts
 * @param {Array<{restSeconds:number|null}>} opts.history sets from the user's
 *   previous session of this exercise (rest taken AFTER each set).
 * @param {number|null} [opts.routineRestSeconds] the routine's own target; not
 *   used by v1 (kept so callers can already pass it).
 * Reserved for later, ignored today: opts.rpe, opts.repDropOff, opts.goal,
 * opts.timeOfDay.
 * @returns {{seconds:number, samples:number}|null} null when no usable samples.
 */
export function computeSuggestedRest({ history = [], routineRestSeconds = null } = {}) {
  void routineRestSeconds;
  const usable = (history || [])
    .map((s) => s?.restSeconds)
    .filter((v) => Number.isFinite(v) && v >= REST_SAMPLE_MIN && v <= REST_SAMPLE_MAX);
  if (!usable.length) return null;
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const clamped = Math.min(REST_SUGGEST_MAX, Math.max(REST_SUGGEST_MIN, mean));
  return { seconds: Math.round(clamped / 5) * 5, samples: usable.length };
}

/**
 * One batched query: for each exerciseId, the user's most recent FINISHED
 * session (other than excludeSessionId) containing it.
 * @returns {Promise<Map<number,{seconds:number,samples:number,basedOnSessionId:number}>>}
 */
export async function loadSuggestedRest(userId, exerciseIds, { excludeSessionId, db = prisma } = {}) {
  const out = new Map();
  const ids = [...new Set((exerciseIds || []).filter((x) => Number.isInteger(x)))];
  if (!ids.length) return out;
  const rows = await db.sessionExercise.findMany({
    where: {
      exerciseId: { in: ids },
      session: {
        userId,
        endedAt: { not: null },
        ...(excludeSessionId != null ? { id: { not: excludeSessionId } } : {}),
      },
    },
    distinct: ['exerciseId'],
    orderBy: [{ session: { startedAt: 'desc' } }, { id: 'desc' }],
    include: { sets: { select: { restSeconds: true } } },
  });
  for (const row of rows) {
    if (out.has(row.exerciseId)) continue;
    const r = computeSuggestedRest({ history: row.sets });
    if (r) out.set(row.exerciseId, { ...r, basedOnSessionId: row.sessionId });
  }
  return out;
}
