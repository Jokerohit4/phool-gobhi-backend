/**
 * Resolves one localDate into the full row list (the single "done" resolver
 * shared by todayService and the score engine).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{userId: number, localDate: string, onLayerKeys?: string[]}} options
 * @returns {Promise<{rows: object[], food: object|null, bonus: number, earned: number, target: number, counts: {done: number, total: number}, onLayerKeys: string[]}>}
 */
export async function resolveDay(prisma, { userId, localDate, onLayerKeys } = {}) {
  throw Object.assign(new Error('not implemented'), { status: 501 });
}
