import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Export and erasure have to list the same tables - we must not delete on
// request something we never showed on request - and the header of
// exportService.js says so. That relationship is only as good as the field
// lists being correct, and a wrong field name in an export is silent: the
// mocked prisma returns whatever object the test hands it, so a projection
// naming a column that does not exist reads as a correct value and would only
// surface as `undefined` in a real download.
//
// So the projections are checked against the schema the same way the writes in
// nutritionService are. Cheap, no database, runs in CI.

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');
const exportSource = readFileSync(join(here, '..', 'services', 'exportService.js'), 'utf8');

const SCALAR = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes', 'BigInt',
]);
const ENUMS = new Set([...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]));

function fieldsOf(model) {
  const body = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(body, `model ${model} is not in the schema`);
  return new Set(
    [...body.matchAll(/^\s{2}(\w+)\s+(\w+)/gm)]
      .filter(([, , type]) => SCALAR.has(type) || ENUMS.has(type))
      .map(([, f]) => f),
  );
}

// The export block, keyed by Prisma model name. Written out by hand rather than
// derived, because the point is to state the intended contract - a list derived
// from the source would only ever agree with itself.
const LEDGER_PROJECTIONS = {
  HealthGoal: ['goal', 'sex', 'age', 'heightCm', 'startDate', 'targetWeightKg', 'targetDate',
    'activity', 'diet', 'allergies', 'activityIsMeasured', 'calmMode'],
  NutritionTarget: ['kcal', 'proteinG', 'carbsG', 'fatG', 'fibreG', 'waterMl', 'source',
    'rulesVersion', 'inputs', 'updatedAt'],
  FoodLog: ['localDate', 'slot', 'name', 'nonVeg', 'grams', 'servings', 'servingLabel',
    'nutrients', 'source', 'photoCorrections', 'createdAt'],
  FoodItem: ['name', 'basis'],
  SavedMeal: ['name', 'slot', 'createdAt'],
  PlanItem: ['title', 'kind', 'schedule', 'endsOn', 'origin', 'prescribedBy', 'prescribedNote',
    'active', 'createdAt'],
  PlanItemCompletion: ['planItemId', 'localDate', 'how', 'points', 'createdAt'],
  ScoreDaySnapshot: ['localDate', 'open', 'high', 'low', 'close', 'breakdown', 'rulesVersion', 'closedAt'],
  HealthCondition: ['label', 'source', 'createdAt'],
  DoctorAppointment: ['doctorName', 'speciality', 'localDate', 'localTime', 'followUpDate',
    'notes', 'createdAt'],
  FoodPhotoRequestLog: ['requestedAt'],
  MedicalDocument: ['title', 'kind', 'docDate', 'mimeType', 'sizeBytes', 'notes', 'createdAt'],
};

// The local variable each model's rows arrive in, so the "is it actually
// projected" check can look for the right identifier.
const ROW_ALIAS = {
  HealthGoal: 'healthGoal', NutritionTarget: 'nutritionTarget', FoodLog: 'f',
  FoodItem: 'f', SavedMeal: 'm', PlanItem: 'p', PlanItemCompletion: 'c',
  ScoreDaySnapshot: 's', HealthCondition: 'c', DoctorAppointment: 'a',
  FoodPhotoRequestLog: 'p', MedicalDocument: 'd',
};

// Deleted implicitly by a cascading parent, so it has no deleteMany of its own
// in consentService.js. Listed so the export/erasure check accounts for it
// rather than reading as a gap in the erasure.
const CASCADES = { PlanItemCompletion: 'PlanItem' };

test('every exported ledger field exists on its model', () => {
  const problems = [];
  for (const [model, fields] of Object.entries(LEDGER_PROJECTIONS)) {
    const real = fieldsOf(model);
    for (const f of fields) {
      if (!real.has(f)) problems.push(`${model}.${f}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `the export names fields the schema does not have: ${problems.join(', ')}. ` +
      'These would appear as null in a real download while passing against the mock.',
  );
});

test('the export actually projects every field it claims to', () => {
  // The mirror of the test above: a field listed in the contract above but
  // missing from the source is a field the download silently drops. This is how
  // the erasure list and the export drifted apart in the first place.
  const problems = [];
  for (const [model, fields] of Object.entries(LEDGER_PROJECTIONS)) {
    for (const f of fields) {
      // Look for the field being read off the row variable inside the map for
      // this model.
      const alias = ROW_ALIAS[model];
      const pattern = new RegExp(`\\b${alias}\\.${f}\\b|\\b${f}:`);
      if (!pattern.test(exportSource)) problems.push(`${model}.${f}`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `the contract lists these fields but the export never reads them: ${problems.join(', ')}`,
  );
});

test('the export never emits a medical storage path', () => {
  // storagePath is a capability. Signed links expire in five minutes and the
  // object is private, so a path in an export file is dead weight that
  // describes where somebody's prescription lives in a bucket.
  const block = exportSource.slice(exportSource.indexOf('medicalRecords: {'));
  assert.doesNotMatch(
    block,
    /storagePath:\s*d\.storagePath|\.\.\.d\b/,
    'the medicalRecords export block must not include storagePath',
  );
});

test('Decimal fields are converted to numbers, not left as strings', () => {
  // Prisma returns Decimal columns as strings over JSON. An export full of
  // "1820" instead of 1820 is a file the recipient has to clean up, and the
  // existing slices here all convert. Spot-checked per model rather than
  // exhaustively, because a missed one is a formatting bug, not a privacy bug.
  for (const [field, model] of [
    ['kcal', 'NutritionTarget'], ['proteinG', 'NutritionTarget'],
    ['targetWeightKg', 'HealthGoal'], ['grams', 'FoodLog'],
    ['distanceMeters', 'ExerciseRecord'],
  ]) {
    assert.ok(
      new RegExp(`Number\\(\\s*\\w+\\.${field}\\s*\\)`).test(exportSource),
      `${model}.${field} should be wrapped in Number() before export`,
    );
  }
});

test('export and erasure cover the same ledger models', () => {
  // The invariant the header of exportService.js claims, checked instead of
  // assumed. DoctorAppointment and the plan/nutrition models must be in both.
  const erasure = readFileSync(join(here, '..', 'services', 'consentService.js'), 'utf8');
  const MODELS = Object.keys(LEDGER_PROJECTIONS);

  const missingFromExport = MODELS.filter(
    (m) => !new RegExp(`prisma\\.${m[0].toLowerCase()}${m.slice(1)}\\.(findMany|findUnique)`).test(exportSource),
  );
  assert.deepEqual(
    missingFromExport,
    [],
    `erased but not exported: ${missingFromExport.join(', ')}. Deleting on request something never shown on request.`,
  );

  const missingFromErasure = MODELS.filter(
    (m) => !new RegExp(`prisma\\.${m[0].toLowerCase()}${m.slice(1)}\\.deleteMany`).test(erasure),
  ).filter((m) => !(m in CASCADES));
  assert.deepEqual(
    missingFromErasure,
    [],
    `exported but not erased: ${missingFromErasure.join(', ')}. Shown on request but never deleted.`,
  );

  // And a cascade is only a substitute if the parent really is deleted.
  for (const [child, parent] of Object.entries(CASCADES)) {
    assert.ok(
      new RegExp(`prisma\\.${parent[0].toLowerCase()}${parent.slice(1)}\\.deleteMany`).test(erasure),
      `${child} is assumed to go with ${parent}, but ${parent} is not deleted either`,
    );
  }
});
