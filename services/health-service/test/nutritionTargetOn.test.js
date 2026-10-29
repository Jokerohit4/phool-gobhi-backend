import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentNutritionTarget, nutritionTargetOn, nutritionTargetFromHistory } from '../services/ledger/currentTarget.js';

const history = [{ effectiveFrom: '2026-10-01', kcal: 1800 }, { effectiveFrom: '2026-10-28', kcal: 2000 }];
function prismaFor(rows) {
  return { nutritionTarget: { findFirst: async ({ where, orderBy }) => {
    assert.equal(where.userId, 7);
    const eligible = rows.filter(r => !where.effectiveFrom || r.effectiveFrom <= where.effectiveFrom.lte);
    return [...eligible].sort((a,b) => orderBy.effectiveFrom === 'desc'
      ? b.effectiveFrom.localeCompare(a.effectiveFrom) : a.effectiveFrom.localeCompare(b.effectiveFrom))[0] ?? null;
  } } };
}
for (const [day, kcal] of [['2026-09-01',1800], ['2026-10-01',1800], ['2026-10-27',1800], ['2026-10-28',2000], ['2026-11-01',2000]]) {
  test(`target on ${day} agrees with fetched history`, async () => {
    assert.equal((await nutritionTargetOn(prismaFor(history), 7, day)).kcal, kcal);
    assert.equal(nutritionTargetFromHistory(history.toReversed(), day).kcal, kcal);
  });
}
test('no target is null; current still returns newest target', async () => {
  assert.equal(await nutritionTargetOn(prismaFor([]), 7, '2026-10-30'), null);
  assert.equal(nutritionTargetFromHistory([], '2026-10-30'), null);
  assert.equal((await currentNutritionTarget(prismaFor(history), 7)).kcal, 2000);
});
