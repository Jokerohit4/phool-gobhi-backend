// Item 5: currentNutritionTarget / nutritionTargetOn read the target and the
// doctor plan together instead of back to back. Same output as before.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentNutritionTarget, nutritionTargetOn } from '../services/ledger/currentTarget.js';

const consent = { scopes: ['medical_records'], scopeVersions: { medical_records: '2026-09-27' } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const record = { id: 4, structuredPlan: { version: 1, confirmed: true, startsOn: '2026-10-01', endsOn: null, targets: { kcal: 1900 }, authenticity: 'user_provided_not_verified' } };

function fake(log) {
  return {
    nutritionTarget: {
      findFirst: async ({ where }) => {
        log.push('target:start'); await delay(15); log.push('target:end');
        if (where.effectiveFrom?.lte) return null; // forces the nutritionTargetOn fallback read
        return { kcal: 2200, proteinG: 120, effectiveFrom: '2026-09-01' };
      },
    },
    ledgerConsent: { findUnique: async () => { log.push('consent:start'); await delay(15); log.push('consent:end'); return consent; } },
    medicalDocument: { findMany: async () => [record] },
  };
}

test('currentNutritionTarget: target read and doctor plan overlap; override still applied', async () => {
  const log = [];
  const target = await currentNutritionTarget(fake(log), 7, '2026-10-30');
  assert.ok(log.indexOf('consent:start') < log.indexOf('target:end'), 'plan lookup started before the target read finished (ordering proves the overlap; no wall-clock threshold, which flakes under load)');
  assert.equal(target.kcal, 1900);
  assert.equal(target.proteinG, 120);
  assert.equal(target.doctorPlan.id, 4);
});

test('nutritionTargetOn: fallback chain and doctor plan overlap; output unchanged', async () => {
  const log = [];
  const target = await nutritionTargetOn(fake(log), 7, '2026-10-30');
  assert.ok(log.indexOf('consent:start') < log.indexOf('target:end'));
  assert.equal(target.kcal, 1900, 'doctor override on top of the oldest-target fallback');
  assert.equal(target.proteinG, 120, 'fallback to the oldest target when none is effective yet');
});

test('no doctor plan -> plain target, no override object', async () => {
  const prisma = { ...fake([]), ledgerConsent: { findUnique: async () => null } };
  const target = await currentNutritionTarget(prisma, 7, '2026-10-30');
  assert.deepEqual(target, { kcal: 2200, proteinG: 120, effectiveFrom: '2026-09-01' });
});
