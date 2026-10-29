import test from 'node:test';
import assert from 'node:assert/strict';
import { foodScoreImpact, nutritionPoints } from '../services/ledger/foodScoreImpact.js';
const target = { kcal: 2000, proteinG: 100 };
const localDate = '2026-10-30';
const food = { kcal: 500, proteinG: 30 };
const logs = [{ id: 1, slot: 'breakfast', grams: 100, nutrients: { kcal: 1200, proteinG: 65 } },
  { id: 2, slot: 'lunch', grams: 100, nutrients: { kcal: 250, proteinG: 5 } }];
test('adding a portion matches the actual engine and includes meal coverage', () => {
  const result = foodScoreImpact({ target, localDate, logs, food, grams: 100, slot: 'dinner' });
  assert.equal(result.status, 'available');
  assert.equal(result.pointsDelta, nutritionPoints([...logs, { slot: 'dinner', nutrients: food }], target, localDate).points - nutritionPoints(logs, target, localDate).points);
  assert.ok(result.reasons.some(r => r.key === 'protein_met'));
  assert.ok(result.reasons.some(r => r.key === 'calories_on_target'));
  assert.ok(result.reasons.some(r => r.key === 'all_meals_logged'));
});
test('doctor targets alter actual points and previews through the same engine', () => {
  const normal = foodScoreImpact({ target, localDate, logs, food, grams: 100, slot: 'dinner' });
  const doctor = foodScoreImpact({ target: { kcal: 1500, proteinG: 75, doctorPlan: { id: 1, targetFields: ['kcal', 'proteinG'] } }, localDate, logs, food, grams: 100, slot: 'dinner' });
  assert.notEqual(normal.pointsDelta, doctor.pointsDelta);
  assert.equal(doctor.doctorPlanUsed, true);
});
test('a portion can remove live calorie points; zero remains an available measured delta', () => {
  const day = [{ id: 1, slot: 'breakfast', nutrients: { kcal: 2000, proteinG: 100 } }];
  assert.ok(foodScoreImpact({ target, localDate, logs: day, food, grams: 100, slot: 'snack' }).pointsDelta < 0);
  const empty = foodScoreImpact({ target, localDate, logs: [], food, grams: 10, slot: 'snack' });
  assert.equal(empty.status, 'available'); assert.equal(empty.pointsDelta, 0);
});
test('included items are marginal, and replacement previews do not count the old portion twice', () => {
  const included = foodScoreImpact({ target, localDate, logs, logId: 1 });
  assert.equal(included.pointsDelta, nutritionPoints(logs, target, localDate).points - nutritionPoints([logs[1]], target, localDate).points);
  const replacement = foodScoreImpact({ target, localDate, logs, replaceLogId: 1, food, grams: 100, slot: 'breakfast' });
  assert.equal(replacement.afterPoints, nutritionPoints([logs[1], { slot: 'breakfast', nutrients: food }], target, localDate).points);
});
test('pending nutrients and missing owned logs never become zero-point claims', () => {
  for (const changed of [{ logId: 33 }, { replaceLogId: 33 },
    { logs: [{ id: 1, nutrients: { unknown: true } }] }, { food: { kcal: null, proteinG: null } }]) {
    assert.equal(foodScoreImpact({ target, localDate, logs, food, grams: 100, slot: 'dinner', ...changed }).status, 'unavailable');
  }
});
