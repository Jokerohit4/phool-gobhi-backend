/**
 * Computes every layer's state (left out / locked / needs_consent / needs_setup / on)
 * from the journey, flags and consents.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{journey?: object, flags?: object}} [options] journey = a getJourney() result; flags from cached app-config when absent
 * @returns {Promise<object[]>} Layer[] as in the /plan/today payload
 */
export async function getLayers(prisma, userId, { journey, flags } = {}) {
  throw Object.assign(new Error('not implemented'), { status: 501 });
}

/**
 * Returns the row layerKeys of on layers plus 'own', and 'medicine' when
 * medical_records is granted. Callers never add ALWAYS_ON_LAYER_KEYS themselves.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{journey?: object}} [options]
 * @returns {Promise<string[]>}
 */
export async function getOnLayerKeys(prisma, userId, { journey } = {}) {
  throw Object.assign(new Error('not implemented'), { status: 501 });
}
