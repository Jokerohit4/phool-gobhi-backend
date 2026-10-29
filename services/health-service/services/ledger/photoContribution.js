// Opt-in research copies of food photos (roadmap Step 1).
//
// Off unless FOOD_PHOTO_CONTRIBUTIONS=true, and each copy needs the user's
// agreement to the exact consent version. Logging a meal never depends on it.
// A kept copy is decoded and re-encoded (which strips EXIF), centre-cropped,
// stored under its own path, and expires on its own clock - separate from the
// 24-hour sweep of unconfirmed photos.
import sharp from 'sharp';
import { readPhoto, saveContribution, deletePhotos } from './foodPhotoStorage.js';

export const CONSENT_VERSION = 'food-research-2026-10-29-v1';

// How sure we are of a label. Only 'strong' (human-reviewed) may enter the
// calibration or final-test splits; the reference gallery accepts all three.
export const LABEL_STRENGTHS = ['weak', 'stronger', 'strong'];

const fail = (message, status) => Object.assign(new Error(message), { status });

/**
 * The label a contribution starts with, taken from what the user confirmed.
 * Accepting the model's answer unchanged is 'weak' - the user and the model are
 * not independent, people often just tap confirm. A user correction is
 * 'stronger'. Only a human review (scripts/photo-review.mjs) makes it 'strong'.
 */
export function initialLabel(logs) {
  const foodIds = [...new Set(logs.map((l) => l.foodItemId).filter((id) => id != null))];
  if (!foodIds.length) return null;
  return {
    strength: logs.some((l) => l.photoCorrections > 0) ? 'stronger' : 'weak',
    source: 'user_confirmed',
    foodIds,
  };
}

export async function contribute(prisma, userId, { photoPath, consentVersion } = {}) {
  if (process.env.FOOD_PHOTO_CONTRIBUTIONS !== 'true') throw fail('Contributions unavailable', 503);
  if (consentVersion !== CONSENT_VERSION) throw fail('Current consent required', 400);
  if (typeof photoPath !== 'string' || !photoPath.startsWith(`food/${userId}/`)) throw fail('Photo unavailable', 404);
  // A swept photo no longer exists in the bucket; refuse it here rather than
  // fail on the download below.
  const claim = await prisma.foodPhotoRequestLog.findFirst({ where: { userId, photoPath, abandonedAt: null } });
  if (!claim) throw fail('Photo unavailable', 404);
  const days = Number(process.env.FOOD_PHOTO_CONTRIBUTION_DAYS || 365);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw fail('Contributions unavailable', 503);

  const logs = await prisma.foodLog.findMany({
    where: { userId, photoPath }, select: { foodItemId: true, photoCorrections: true },
  });
  const buffer = await sharp(await readPhoto(photoPath), { limitInputPixels: 40000000 })
    .rotate().resize(768, 768, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
  const path = await saveContribution({ buffer, userId });
  try {
    return await prisma.foodPhotoContribution.create({ data: {
      userId, path, consentVersion, label: initialLabel(logs),
      expiresAt: new Date(Date.now() + days * 86400000),
    } });
  } catch (e) {
    await deletePhotos([path]);
    throw e;
  }
}

/**
 * Withdrawal. Never blocks: copies whose blob deleted are removed now, and any
 * blob that failed to delete is marked expired so the retention sweep retries
 * it. A storage outage must not make it impossible to withdraw consent.
 */
export async function removeContributions(prisma, userId) {
  const rows = await prisma.foodPhotoContribution.findMany({ where: { userId } });
  if (!rows.length) return { deleted: 0, pending: 0 };
  const { failed } = await deletePhotos(rows.map((r) => r.path));
  const failedPaths = new Set(failed);
  const done = rows.filter((r) => !failedPaths.has(r.path)).map((r) => r.id);
  if (done.length) await prisma.foodPhotoContribution.deleteMany({ where: { id: { in: done } } });
  if (failedPaths.size) {
    await prisma.foodPhotoContribution.updateMany({
      where: { userId, path: { in: [...failedPaths] } }, data: { expiresAt: new Date(0) },
    });
  }
  return { deleted: done.length, pending: failedPaths.size };
}

// Run by the weekly retention sweep and the admin photo sweep.
export async function sweepContributions(prisma, now = new Date()) {
  const rows = await prisma.foodPhotoContribution.findMany({ where: { expiresAt: { lte: now } } });
  let deleted = 0;
  if (rows.length) {
    const { failed } = await deletePhotos(rows.map((r) => r.path));
    const failedPaths = new Set(failed);
    const done = rows.filter((r) => !failedPaths.has(r.path)).map((r) => r.id);
    if (done.length) ({ count: deleted } = await prisma.foodPhotoContribution.deleteMany({ where: { id: { in: done } } }));
  }
  const { count: cache } = await prisma.foodPhotoRecognitionCache.deleteMany({ where: { expiresAt: { lte: now } } });
  return { contributions: deleted, pending: rows.length - deleted, cacheEntries: cache };
}
