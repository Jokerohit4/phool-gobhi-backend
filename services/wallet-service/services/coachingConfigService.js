import prisma from '../db/prisma.js';
import { defaultCoachingConfig, validateCoachingConfig } from './coachingDefaults.js';

export async function getCoachingConfig() {
  const row = await prisma.coachingCatalogConfig.findUnique({ where: { id: 1 } });
  return row ? { version: row.version, config: row.config, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
    : { version: 0, config: defaultCoachingConfig(), updatedAt: null, updatedBy: null };
}
export async function saveCoachingConfig(input, expectedVersion, actor) {
  const config = validateCoachingConfig(input);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw Object.assign(new Error('Reload the plan editor before saving'), { status: 400 });
  try {
    return await prisma.$transaction(async tx => {
      const version = expectedVersion + 1;
      if (expectedVersion === 0) await tx.coachingCatalogConfig.create({ data: { id: 1, version, config, updatedBy: actor } });
      else {
        const saved = await tx.coachingCatalogConfig.updateMany({ where: { id: 1, version: expectedVersion }, data: { config, version, updatedBy: actor } });
        if (!saved.count) throw Object.assign(new Error('Another admin changed the plans. Reload before saving.'), { status: 409 });
      }
      await tx.coachingCatalogConfigHistory.create({ data: { version, config, updatedBy: actor } });
      return { version, config };
    });
  } catch (e) {
    if (e.code === 'P2002') throw Object.assign(new Error('Another admin changed the plans. Reload before saving.'), { status: 409 });
    throw e;
  }
}
export async function coachingConfigHistory() {
  return prisma.coachingCatalogConfigHistory.findMany({ orderBy: { version: 'desc' }, take: 30 });
}
