// The AI may suggest plan items, and it may never suggest a doctor's line.
//
// The assistant writes through addUserEnteredItem with fromPrescription unset,
// so everything it creates lands as origin: 'user' — which is correct, and is
// the only reason it can write to the plan at all. The danger is the KIND, not
// the origin: a `doctor_medication` row written by the model scores +10 a day
// for a medicine we invented, and remediation.js ranks a missed doctor item
// above a missed workout. So the boundary is enforced on the kind the model
// chose.
//
// normaliseAiKind is exported and tested directly rather than through
// injectAiPrescription, because that function constructs its own PrismaClient at
// module scope and there is no database in this suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseAiKind } from '../services/aiPrescriptionService.js';
import { PLAN_ITEM_KINDS } from '../services/ledger/ledgerPlanService.js';

test('every doctor kind is refused', () => {
  const doctorKinds = PLAN_ITEM_KINDS.filter((k) => k.startsWith('doctor_'));
  assert.equal(doctorKinds.length, 3, 'expected medication, test and appointment');

  for (const kind of doctorKinds) {
    assert.throws(
      () => normaliseAiKind(kind),
      /assistant cannot add a doctor item/,
      `${kind} must not be writable by the assistant`,
    );
  }
});

test('an appointment is refused — it is the kind most likely to look innocuous', () => {
  // "Book a follow-up in six weeks" is normal assistant territory, and as a plan
  // item it is a doctor's line.
  assert.throws(() => normaliseAiKind('doctor_appointment'), /doctor item/);
});

test('casing and whitespace do not bypass the guard', () => {
  // These would be refused by the allow-list too, but as nonsense kinds, which
  // tells the user nothing. Normalising first means they all get the real reason.
  for (const kind of ['DOCTOR_MEDICATION', ' doctor_medication ', 'Doctor_Medication', '\tdoctor_test\n']) {
    assert.throws(() => normaliseAiKind(kind), /doctor item/, `"${kind}" must be refused`);
  }
});

test('an unknown kind is passed through so the allow-list rejects it with a 400', () => {
  // Not swallowed here: normaliseAiKind is not the validator, and a kind this
  // function cannot vouch for should reach the one that can answer properly.
  assert.equal(normaliseAiKind('medicine'), 'medicine');
});

test('the retired custom kind maps to the same default the client dialog uses', () => {
  // 'custom' was the old default here and is not a member of the enum, so it
  // reached Prisma and surfaced as a 500 on a feature the user had just accepted.
  assert.equal(normaliseAiKind('custom'), 'habit');
  assert.equal(normaliseAiKind(undefined), 'habit');
  assert.equal(normaliseAiKind(null), 'habit');
  assert.equal(normaliseAiKind(''), 'habit');
  assert.equal(normaliseAiKind('   '), 'habit');
});

test('ordinary kinds pass through unchanged', () => {
  for (const kind of ['nutrition', 'workout', 'habit', 'rest']) {
    assert.equal(normaliseAiKind(kind), kind);
  }
});

test('every kind the guard lets through is a kind the database has', () => {
  // The two halves agreeing. normaliseAiKind returning something addUserEnteredItem
  // would reject is a 500-shaped mistake waiting to happen.
  for (const kind of PLAN_ITEM_KINDS) {
    if (kind.startsWith('doctor_')) continue;
    assert.equal(
      normaliseAiKind(kind),
      kind,
      `${kind} must survive normalisation`,
    );
  }
});