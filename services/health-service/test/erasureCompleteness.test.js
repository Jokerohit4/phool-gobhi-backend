import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// This suite does not import the service. deleteAllDataService reaches for a
// live PrismaClient at module load, and the point of these tests is that the
// ERASURE LIST ITSELF stays complete as tables are added to this schema - a
// property that a behavioural test with a mocked prisma cannot check, because
// the mock only knows about the tables someone remembered to stub.
//
// So the list is read out of the source and compared against the schema. The
// failure mode this exists to prevent: someone adds a model holding health
// data, forgets to add it here, and a user's prescriptions outlive their
// account while every test in the repo stays green.

const here = dirname(fileURLToPath(import.meta.url));
const serviceSource = readFileSync(join(here, '..', 'services', 'consentService.js'), 'utf8');
const schemaSource = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');

// Models that hold per-user data and must be erased with the account.
const MUST_ERASE = [
  'HealthGoal',
  'HealthCondition',
  'NutritionTarget',
  'FoodItem',
  'FoodLog',
  'SavedMeal',
  'PlanItem',
  'MedicalDocument',
  'DoctorAppointment',
  'ScoreDaySnapshot',
  'FoodPhotoRequestLog',
];

// Models whose rows cascade from a parent that IS in the list, so an explicit
// delete would be redundant. Enumerated rather than left implicit, so that
// promoting one of these to MUST_ERASE is a visible edit.
const CASCADING = {
  SavedMealLine: 'SavedMeal',
  PlanItemCompletion: 'PlanItem',
};

// Prisma names the client accessor after the model in lowerCamelCase, so
// `model HealthGoal` is `prisma.healthGoal`. Comparing the raw model name
// against the source would report every table as missing and the test would
// pass vacuously while erasing nothing.
const accessor = (model) => model[0].toLowerCase() + model.slice(1);

test('every ledger model is either erased explicitly or cascades from one that is', () => {
  const missing = MUST_ERASE.filter(
    (m) => !new RegExp(`prisma\\.${accessor(m)}\\.deleteMany`).test(serviceSource),
  );
  assert.deepEqual(
    missing,
    [],
    `these models are not in deleteAllDataService: ${missing.join(', ')}. ` +
      'An erasure that misses one of these leaves a user\'s own health data ' +
      'behind after account deletion.',
  );
});

test('MedicalDocument - the most sensitive table here - is erased', () => {
  // Checked on its own and named in the failure message, because this is the
  // one where a miss is a prescription outliving the person it was prescribed
  // to.
  assert.match(serviceSource, /prisma\.medicalDocument\.deleteMany/);
});

test('a custom food is erased, but only the user\'s own', () => {
  // FoodItem is shared: seeded rows belong to nobody. Deleting the whole table
  // would wipe the catalogue for every other user on an erasure.
  assert.match(serviceSource, /prisma\.foodItem\.deleteMany\(\{ where: \{ createdByUserId: userId \} \}\)/);
  assert.doesNotMatch(serviceSource, /prisma\.foodItem\.deleteMany\(\{ where: \{ userId/);
});

test('the health audit trail survives erasure, and the reason is written down', () => {
  // Deleting the audit log during an erasure erases the proof the erasure
  // happened. This is asserted so nobody "tidies up" the omission later.
  assert.doesNotMatch(serviceSource, /prisma\.healthDataAuditLog\.deleteMany/);
  assert.match(serviceSource, /NOT deleted here: HealthDataAuditLog/);
});

test('the assistant transcript is erased', () => {
  // A user may have typed a condition or a medication into it.
  assert.match(serviceSource, /prisma\.assistantMessage\.deleteMany/);
  assert.match(serviceSource, /prisma\.assistantConversation\.deleteMany/);
});

test('the medical blob sweep runs after the transaction, not inside it', async () => {
  // Inside the transaction, a GCS outage would roll back a committed erasure
  // and holding a transaction open across a third-party network call is how a
  // deletion silently stops completing.
  const sweep = serviceSource.indexOf('deleteUserObjects');
  const transactionEnd = serviceSource.lastIndexOf(']);');
  assert.ok(sweep > -1, 'deleteUserObjects is never called');
  assert.ok(sweep > transactionEnd, 'the blob sweep must run after the transaction commits');
  // And it must not be allowed to fail the erasure.
  assert.match(serviceSource, /catch \(err\) \{[\s\S]*?medical blob sweep failed/);
});

test('the cascading models are named in the source with their parent', () => {
  // A reader auditing this list should not have to open the schema to know why
  // two tables are missing from it.
  for (const [child, parent] of Object.entries(CASCADING)) {
    const model = schemaSource.match(new RegExp(`model ${child} \\{[^}]*`))?.[0] || '';
    assert.match(
      model,
      new RegExp(`onDelete: Cascade`),
      `${child} is listed as cascading from ${parent} but the schema no longer says so`,
    );
  }
});

test('the erasure list has no delete scoped to a table that does not exist', () => {
  // Catches a rename that left a stale prisma.<model>.deleteMany behind, which
  // would throw at runtime and fail the whole erasure.
  const models = new Set(
    [...schemaSource.matchAll(/^model (\w+) \{/gm)].map((m) => accessor(m[1])),
  );
  const referenced = [...serviceSource.matchAll(/prisma\.(\w+)\.deleteMany/g)].map((m) => m[1]);
  const unknown = [...new Set(referenced)].filter((m) => !models.has(m));
  assert.deepEqual(unknown, [], `deleteAllDataService references models that are not in the schema: ${unknown.join(', ')}`);
});
