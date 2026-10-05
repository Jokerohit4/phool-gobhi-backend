// "The user's current nutrition target", in one place.
//
// NutritionTarget used to be keyed PRIMARY KEY (userId) — one row per user —
// so every reader called `findUnique({ where: { userId } })`. It is now an
// append-only history (migration 20261009000000_nutrition_target_history): a
// surrogate `id`, an `effectiveFrom` day string, and UNIQUE (userId,
// effectiveFrom). That makes `findUnique({ where: { userId } })` invalid, and
// seven call sites across the ledger controller, scoreService and exportService
// were relying on it.
//
// So the query that replaced it lives here rather than being copy-pasted seven
// times. Copy-pasting it is how you get six readers on today's target and one
// on last month's, and the difference only shows up as a number that quietly
// stops moving.
//
// "Current" means newest effectiveFrom, not newest id and not most recently
// written. A row can be backfilled (an import, a migration backfill) out of id
// order, and the day a target took effect is the fact that decides which one the
// user is living on.

/**
 * The user's newest nutrition target, or null when they have never had one.
 *
 * Returns the full row, because every caller wants at least two of
 * kcal/inputs/source and picking fields here would mean every caller
 * re-selecting the same six columns differently.
 */
export async function currentNutritionTarget(prisma, userId) {
  return prisma.nutritionTarget.findFirst({
    where: { userId },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/**
 * The same, for a caller that only needs to know a target exists.
 *
 * Cheaper in intent, not in queries: the caller is saying "don't compute
 * anything if there's no target", which is a different question from "give me
 * the target" and is worth naming, because the score path calls it on every day
 * close.
 */
export async function hasCurrentNutritionTarget(prisma, userId) {
  const row = await currentNutritionTarget(prisma, userId);
  return Boolean(row);
}