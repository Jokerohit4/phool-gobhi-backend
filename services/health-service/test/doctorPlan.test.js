import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDoctorPlan, activeDoctorPlan, applyDoctorTargets } from '../services/ledger/doctorPlan.js';
import { currentNutritionTarget } from '../services/ledger/currentTarget.js';
const day = '2026-10-30';
const input = { confirmed: true, startsOn: day, targets: { kcal: 1900, proteinG: 85 }, doctorName: '' };
test('optional doctor details remain unverified; omitted targets remain absent', () => {
  const plan = validateDoctorPlan({ ...input, targets: { proteinG: 85 } }, day);
  assert.deepEqual(plan.targets, { proteinG: 85 });
  assert.equal(plan.doctorName, '');
  assert.equal(plan.authenticity, 'user_provided_not_verified');
  assert.equal(validateDoctorPlan({ ...input, authenticity: 'verified' }, day).authenticity, 'user_provided_not_verified');
});
test('confirmation, real dates, numeric values and doctor detail lengths are validated', () => {
  for (const changed of [{ confirmed: false }, { startsOn: '2026-10-29' }, { startsOn: '2026-11-31' },
    { endsOn: '2026-10-29' }, { doctorName: 'a'.repeat(121) },
    ...[0, -1, '1900', Infinity, NaN, 20001].map(kcal => ({ targets: { kcal } }))]) {
    assert.throws(() => validateDoctorPlan({ ...input, ...changed }, day), { status: 400 });
  }
});
const consent = { scopes: ['medical_records'], scopeVersions: { medical_records: '2026-09-27' } };
function store({ grant = consent, records = [] } = {}) {
  return {
    ledgerConsent: { findUnique: async ({ where }) => { assert.equal(where.userId, 7); return grant; } },
    medicalDocument: { findMany: async ({ where }) => { assert.equal(where.userId, 7); assert.ok(where.OR); return records; } },
  };
}
const record = { id: 4, structuredPlan: { version: 1, ...input, authenticity: 'user_provided_not_verified' } };
test('only current medical consent activates targets; expired plans restore ordinary targets', async () => {
  for (const grant of [null, { ...consent, revokedAt: new Date() }, { ...consent, scopes: ['nutrition'] },
    { ...consent, scopeVersions: {} }]) {
    assert.equal(await activeDoctorPlan(store({ grant, records: [record] }), 7, day), null);
  }
  const expired = { ...record, structuredPlan: { ...record.structuredPlan, endsOn: '2026-10-29' } };
  assert.equal(await activeDoctorPlan(store({ records: [expired, record] }), 7, day), null, 'expired winner must not fall through to an older plan');
  const active = await activeDoctorPlan(store({ records: [record] }), 7, day);
  const baseline = { kcal: 2200, proteinG: 120, carbsG: 250, source: 'formula' };
  assert.equal(applyDoctorTargets(baseline, null), baseline);
  const target = applyDoctorTargets(baseline, active);
  assert.equal(target.kcal, 1900); assert.equal(target.proteinG, 85); assert.equal(target.carbsG, 250);
  assert.equal(baseline.kcal, 2200, 'the baseline history must not be rewritten');
});
test('all readers resolve the same prescribed targets without writing nutrition history', async () => {
  const prisma = { ...store({ records: [record] }), nutritionTarget: { findFirst: async () => ({ kcal: 2200, proteinG: 120 }) } };
  const target = await currentNutritionTarget(prisma, 7, day);
  assert.equal(target.kcal, 1900); assert.equal(target.doctorPlan.id, 4);
});
test('legacy plain-text documents never activate a scoring override', async () => {
  assert.equal(await activeDoctorPlan(store({ records: [{ id: 9, notes: '1900 calories' }] }), 7, day), null);
});
