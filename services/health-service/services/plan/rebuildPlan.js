/**
 * Rebuilds the user's suggested plan rows from the on-layer keys and current
 * targets/slots; stable ids via (kind, layerKey, schedule, sourceRef ?? '').
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{reason: 'start'|'unlock'|'consent'|'setup'|'edit'|'supplements'|'migrate'}} options
 * @returns {Promise<{created: number, updated: number, deactivated: number, onLayerKeys: string[]}>}
 */
export async function rebuildPlan(prisma, userId, { reason } = {}) {
  throw Object.assign(new Error('not implemented'), { status: 501 });
}
