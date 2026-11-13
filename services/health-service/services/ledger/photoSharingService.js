import { contribute, removeContributions } from './photoContribution.js';

// A per-photo v1 grant never becomes permission for future photos.
export const SHARING_CONSENT_VERSION = 'food-research-future-2026-10-29-v2';
const available = () => process.env.FOOD_PHOTO_CONTRIBUTIONS === 'true';
const fail = (message, status) => Object.assign(new Error(message), {status});

async function withUserLock(prisma, userId, work) {
  return prisma.$transaction(async tx => {
    const key = `photo-sharing:${userId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    return work(tx);
  }, {timeout:30000});
}

export async function getSharingPreference(prisma, userId) {
  const row = await prisma.foodPhotoSharingPreference.findUnique({where:{userId}});
  const current = row?.consentVersion === SHARING_CONSENT_VERSION;
  return {decided:!!current, enabled:!!current && row.enabled, available:available(), consentVersion:SHARING_CONSENT_VERSION};
}

export async function setSharingPreference(prisma, userId, {enabled, consentVersion} = {}) {
  if (typeof enabled !== 'boolean' || consentVersion !== SHARING_CONSENT_VERSION) throw fail('Current sharing choice required',400);
  if (enabled && !available()) throw fail('Photo sharing unavailable',503);
  await withUserLock(prisma,userId,tx => tx.foodPhotoSharingPreference.upsert({
    where:{userId}, create:{userId,enabled,consentVersion}, update:{enabled,consentVersion,decidedAt:new Date()},
  }));
  return getSharingPreference(prisma,userId);
}

// This switch is durable before storage cleanup, including during an outage.
export async function withdrawSharing(prisma,userId) {
  await withUserLock(prisma,userId,tx => tx.foodPhotoSharingPreference.upsert({where:{userId},create:{userId,enabled:false,consentVersion:SHARING_CONSENT_VERSION},update:{enabled:false,consentVersion:SHARING_CONSENT_VERSION,decidedAt:new Date()}}));
  return removeContributions(prisma,userId);
}

export async function shareConfirmedPhoto(prisma,userId,photoPath,{save=contribute}={}) {
  if (!available()) return {outcome:'disabled'};
  return withUserLock(prisma,userId,async tx => {
    const pref = await getSharingPreference(tx,userId);
    if (!pref.enabled) return {outcome:'not_opted_in'};
    // No scanner/backfill: only the current successful confirmation reaches here.
    const existing = await tx.foodPhotoContribution.findUnique({where:{userId_sourcePhotoPath:{userId,sourcePhotoPath:photoPath}}});
    if (existing) return {outcome:'already_shared'};
    const confirmed = await tx.foodLog.count({where:{userId,photoPath}});
    if (!confirmed) return {outcome:'not_confirmed'};
    await save(tx,userId,{photoPath,consentVersion:SHARING_CONSENT_VERSION});
    return {outcome:'shared'};
  });
}

export async function tryShareConfirmedPhoto(...args) {
  try { return await shareConfirmedPhoto(...args); }
  catch { return {outcome:'failed'}; }
}
