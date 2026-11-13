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
//
// SCHEMA SWEEP: parse schema.prisma; every model with a `userId` field must
// appear in the erasure list (consentService.js deleteAllDataService) or in
// an explicit EXEMPT list with a reason. ExerciseContent and CoachArticle have
// no userId, so they aren't swept.

const here = dirname(fileURLToPath(import.meta.url));
const serviceSource = readFileSync(join(here, '..', 'services', 'consentService.js'), 'utf8');
const schemaSource = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');

// Prisma names the client accessor after the model in lowerCamelCase, so
// `model HealthGoal` is `prisma.healthGoal`.
const accessor = (model) => model[0].toLowerCase() + model.slice(1);

// Models that hold per-user data but are NOT erased because they cascade from
// a parent that IS erased. Enumerated rather than left implicit, so that
// promoting one of these to MUST_ERASE is a visible edit.
// The test also verifies that the schema still declares the cascade.
const CASCADING = {
  SavedMealLine: 'SavedMeal',
  PlanItemCompletion: 'PlanItem',
  // Every biomarker OCR proposed from a lab report. Enumerated rather than left
  // implicit so that promoting it to MUST_ERASE stays a visible edit.
  ReportExtraction: 'HealthReport',
};

// Models that have a userId but are EXEMPT from erasure, with a written
// reason. These are tables that must survive account deletion for legal,
// audit, or cross-service integrity reasons. Adding an entry here requires a
// code review comment explaining why the data must not be erased.
const EXEMPT = {
  HealthDataAuditLog: 'audit trail of who touched this person\'s health data; deleting it during erasure would erase the proof the erasure happened',
};

function extractModelsWithUserId(schema) {
  // Find all model blocks and check if they have a userId field
  const modelRegex = /model\s+(\w+)\s+\{([^}]+)\}/g;
  const models = [];
  let match;
  while ((match = modelRegex.exec(schema)) !== null) {
    const modelName = match[1];
    const modelBody = match[2];
    // Check for userId field (can be `userId Int`, `userId Int @id`, `userId Int?`, etc.)
    // Must match `userId` as a whole word at the start of a field declaration, not
    // `createdByUserId` or other fields ending with userId.
    if (/^\s+userId\s+(Int|String)\b/m.test(modelBody)) {
      models.push(modelName);
    }
  }
  return models;
}

function extractErasedModels(serviceSource) {
  // Find all prisma.<model>.deleteMany calls
  const erased = new Set();
  const regex = /prisma\.(\w+)\.deleteMany/g;
  let match;
  while ((match = regex.exec(serviceSource)) !== null) {
    erased.add(match[1]);
  }
  return erased;
}

const modelsWithUserId = extractModelsWithUserId(schemaSource);
const erasedModels = extractErasedModels(serviceSource);

test('schema sweep: every model with userId is erased, cascades, or is explicitly exempt', () => {
  const missing = [];
  for (const model of modelsWithUserId) {
    const acc = accessor(model);
    if (erasedModels.has(acc)) continue;
    if (CASCADING[model]) continue;
    if (EXEMPT[model]) continue;
    missing.push(model);
  }
  assert.deepEqual(
    missing,
    [],
    'these models have a userId but are not in deleteAllDataService, not cascading, and not exempt: ' +
      missing.join(', ') +
      '. An erasure that misses one of these leaves a user\'s own health data behind after account deletion.'
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

// Food photos are the second kind of blob this service holds, and unlike the
// medical ones they are NOT throwaway: the user chose to keep the picture on the
// log. That makes the blob sweep a deletion obligation rather than a courtesy,
// and it is exactly the kind of thing that gets added later and never wired into
// the erasure path.
test('the food photo blobs are swept on erasure, after the transaction', () => {
  const sweep = serviceSource.indexOf('deleteUserPhotos');
  const transactionEnd = serviceSource.lastIndexOf(']);');
  assert.ok(sweep > -1, 'deleteUserPhotos is never called - photos outlive the account');
  assert.ok(
    sweep > transactionEnd,
    'the food photo sweep must run after the transaction commits, like the medical one',
  );
  // Same reasoning: the row erasure is the meaningful part and has happened.
  assert.match(serviceSource, /catch \(err\) \{[\s\S]*?food photo blob sweep failed/);
});

test('revoking nutrition consent reclaims the photos too, not just the rows', () => {
  // A user who withdraws nutrition consent has asked us to stop holding their
  // food record. The rows going is not enough while the photographs - which show
  // the same information and more - stay in the bucket.
  const source = readFileSync(
    join(here, '..', 'services', 'ledger', 'ledgerConsentService.js'),
    'utf8',
  );
  assert.match(source, /photoPath: \{ not: null \}/, 'the photo paths are never read before the delete');
  assert.match(source, /deletePhotos/);
  // And the request ledger goes in the same transaction - a row recording what
  // this user photographed, and what it cost, is itself part of the record.
  assert.match(source, /prisma\.foodPhotoRequestLog\.deleteMany/);
  // And so do the foods this person could not find. Same table, same
  // transaction: a revoked nutrition scope must not leave a free-text record of
  // somebody's diet behind just because nothing renders it in the app.
  assert.match(source, /prisma\.foodRequest\.deleteMany/);
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

test('Exempt models have a written reason and are not accidentally erased', () => {
  for (const [model, reason] of Object.entries(EXEMPT)) {
    const acc = accessor(model);
    assert.doesNotMatch(
      serviceSource,
      new RegExp(`prisma\\.${acc}\\.deleteMany`),
      `${model} is exempt (${reason}) but appears in deleteAllDataService`
    );
    assert.ok(reason.length > 10, `${model} exemption reason is too short: "${reason}"`);
  }
});