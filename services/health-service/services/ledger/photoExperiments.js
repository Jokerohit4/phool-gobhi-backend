// Cost experiments for the food photo call, all off by default. Each is an
// environment switch so a benchmark can turn one on at a time and trace any
// change in accuracy, latency or failures to its cause.
import { createHash } from 'node:crypto';

const MODES = ['baseline', 'same_call', 'separate'];
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
let warned = false;

// A misspelt value falls back to the current behaviour with a warning. Throwing
// here would turn one bad secret into a 500 on every photo.
export function experimentConfig() {
  let mode = process.env.FOOD_PHOTO_NUTRITION_MODE || 'baseline';
  if (!MODES.includes(mode)) {
    if (!warned) console.warn('[foodPhoto] unknown FOOD_PHOTO_NUTRITION_MODE, using baseline');
    warned = true;
    mode = 'baseline';
  }
  return {
    version: 'photo-v2',
    mode,
    shortlist: process.env.FOOD_PHOTO_SHORTLIST === 'true',
    lowResolution: process.env.FOOD_PHOTO_LOW_RESOLUTION === 'true',
    thinking: process.env.FOOD_PHOTO_THINKING || null,
  };
}

/**
 * Request controls for one model. A control the model does not support is
 * skipped rather than thrown: the provider rotation mixes model families, and
 * the fallback candidate must still work when the primary's setting does not
 * apply to it.
 */
export function generationControls(model, config) {
  const out = {};
  const gemini3 = /^gemini-[3-9][.\-]/.test(model);
  if (config.lowResolution && gemini3) out.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  if (config.thinking != null) {
    if (/^gemini-2\.5-/.test(model) && /^\d+$/.test(config.thinking)) {
      out.thinkingConfig = { thinkingBudget: Number(config.thinking) };
    } else if (gemini3 && THINKING_LEVELS.includes(config.thinking)) {
      out.thinkingConfig = { thinkingLevel: config.thinking };
    }
  }
  return out;
}

export function duplicateKey(userId, buffer, configuration) {
  return createHash('sha256').update(String(userId)).update('\0')
    .update(JSON.stringify(configuration)).update('\0').update(buffer).digest('hex');
}

/**
 * Exact-duplicate cache: the same user sending the same bytes under the same
 * configuration gets the stored proposal instead of a paid call.
 *
 * No transaction is held around the call. Holding one for a 20-second provider
 * request pinned a pooled connection while the work inside needed others, so a
 * few photos at once could exhaust the pool. The cost of not locking is that
 * two identical uploads in the same second may both pay - acceptable for a
 * cache whose job is re-uploads, not races.
 */
export async function cachedRecognition(prisma, { userId, buffer, configuration, now = new Date() }, call) {
  if (process.env.FOOD_PHOTO_EXACT_CACHE !== 'true') return call();
  const hours = Number(process.env.FOOD_PHOTO_CACHE_HOURS || 24);
  if (!(hours > 0 && hours <= 168)) return call();
  const key = duplicateKey(userId, buffer, configuration);
  const cached = await prisma.foodPhotoRecognitionCache.findUnique({ where: { key } });
  if (cached && cached.expiresAt > now) return { ...cached.proposal, cacheHit: true };
  const proposal = await call();
  if (proposal.isFood && proposal.items?.length) {
    const data = { userId, proposal, expiresAt: new Date(now.getTime() + hours * 3600000) };
    await prisma.foodPhotoRecognitionCache.upsert({ where: { key }, create: { key, ...data }, update: data });
  }
  return proposal;
}
