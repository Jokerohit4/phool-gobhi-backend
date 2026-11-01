/**
 * A per-request memoised workout-template loader (template + its exercises).
 * buildToday shares one between the session preview and the day resolver so the
 * same template is read once instead of once per consumer / workout row.
 *
 * Lives in its own module (no imports) so both todayService and rowProgress can
 * use it without depending on each other.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {(templateId: number|null|undefined) => Promise<object|null>}
 */
export function makeTemplateLoader(prisma) {
  const cache = new Map();
  return (templateId) => {
    if (!templateId) return Promise.resolve(null);
    if (!cache.has(templateId)) {
      cache.set(templateId, prisma.workoutTemplate.findUnique({
        where: { id: templateId }, include: { exercises: true },
      }));
    }
    return cache.get(templateId);
  };
}
