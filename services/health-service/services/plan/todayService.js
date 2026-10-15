/**
 * Builds the GET /plan/today payload (state, rows, session, layers, week, journey).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{localDate?: string}} [options] optional and ignored if in the future
 * @returns {Promise<object>} the /plan/today response body
 */
export async function buildToday(prisma, userId, { localDate } = {}) {
  throw Object.assign(new Error('not implemented'), { status: 501 });
}

/**
 * Builds the GET /plan payload (settings, bounds, slots, items, layers, templates).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @returns {Promise<object>} the /plan response body
 */
export async function buildPlanDefinition(prisma, userId) {
  throw Object.assign(new Error('not implemented'), { status: 501 });
}
