import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `prisma validate` checks the schema in isolation. It does not know that the
// hand-authored migration has drifted from it, and the only way that shows up is
// at deploy time - as a column that does not exist, or worse, a table created
// from a migration whose column list never got the new field.
//
// This compares the two directly. It is deliberately textual rather than
// spinning up a database: a PGlite or testcontainer run would catch more, but
// this needs no infrastructure, so it can run in CI and before every deploy.

const here = dirname(fileURLToPath(import.meta.url));
const schemaRaw = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');

// Every migration, concatenated, not just the one that created the ledger.
//
// This originally read only `20260927000000_add_health_ledger`, which was
// correct while that was the only migration touching these models and quietly
// wrong the moment it stopped being true. Photo logging added its columns in a
// later ALTER, and a test pinned to the original CREATE TABLE would have
// reported every one of them as "in the schema but not the migration" - a false
// alarm pointing the other way, at a developer who did nothing wrong.
//
// The union is the right shape for this question. The question is "is every
// column the schema declares created by the migrations, in some migration", and
// an ALTER and a CREATE are both ways to create a column. Order is irrelevant to
// a column's existence, and a column added then dropped correctly shows up in
// the reverse check below rather than being silently tolerated here.
const migrationsDir = join(here, '..', 'prisma', 'migrations');
const migrationRaw = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => readFileSync(join(migrationsDir, e.name, 'migration.sql'), 'utf8'))
  .join('\n');

// Comments are stripped before anything is matched. The migration carries a
// lot of `--` explanation, and several of those sentences contain a semicolon -
// so a regex that scans for the next `;` to find the end of a CREATE TABLE
// stops halfway through the table, at a semicolon inside prose, and reports
// every column after that point as missing. That is what the first run of this
// test did, and the failure was entirely in the test.
function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}
const schema = schemaRaw;
const migration = stripSqlComments(migrationRaw);

// Prisma scalar types. A field whose type is anything else is either an enum
// (a column) or a relation (not a column), so the two have to be told apart.
const SCALAR = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes', 'BigInt',
]);
const ENUMS = new Set([...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]));

function modelBody(source, name) {
  return source.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
}

function migrationCreateTable(name) {
  return migration.match(
    new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"?\\w*"\\.("${name}")"?[^;]*?;`, 's'),
  )?.[0] || '';
}

function schemaFields(name) {
  return new Set(
    [...modelBody(schema, name).matchAll(/^\s{2}(\w+)\s+(\w+)/gm)]
      // A column is a Prisma builtin scalar or a declared enum. Everything
      // else is a relation - `target NutritionTarget?`, `logs FoodLog[]` - and
      // has no column in either file. Filtering on the builtin list alone
      // dropped every enum-typed column, since an enum type name is not a
      // scalar name.
      .filter(([, , type]) => SCALAR.has(type) || ENUMS.has(type))
      .map(([, field]) => field),
  );
}

function migrationColumns(name) {
  const cols = new Set();
  const table = migrationCreateTable(name);
  if (table) {
    // The column type varies - `INTEGER`, `DECIMAL(8,2)`, and for enums the
    // schema-qualified `"health"."MealSlot"` - so the match only anchors on the
    // quoted column name at the start of a line. Requiring a bare type token here
    // silently skipped every enum-typed column, which is most of this schema.
    for (const m of table.matchAll(/^\s+"(\w+)"\s+\S/gm)) cols.add(m[1]);
  }

  // Columns added after the fact, via ALTER TABLE.
  //
  // This was missing, and it was missing in the direction that hides a real
  // regression: every model here was created by one big migration, so a CREATE
  // TABLE scan looked complete right up until the first feature that needed a
  // new column, at which point every later column reported as missing from the
  // migrations and pointed the reader at the wrong file. A column is created
  // whether the statement that creates it is a CREATE or an ALTER.
  // `(?!\w)` rather than `\b`: the pattern ends on a closing quote, and a word
  // boundary requires a word character on one side of it. `\b` after a quote is
  // unsatisfiable, which made this silently match nothing.
  for (const stmt of migration.split(';')) {
    if (!new RegExp(`^\\s*ALTER TABLE (?:IF EXISTS )?"?\\w*"\\."${name}"(?!\\w)`, 'i').test(stmt)) continue;
    for (const m of stmt.matchAll(/ADD COLUMN (?:IF NOT EXISTS )?"(\w+)"/gi)) cols.add(m[1]);
  }

  return cols.size ? cols : null;
}

const LEDGER_MODELS = [
  'HealthGoal',
  'NutritionTarget',
  'FoodItem',
  'FoodLog',
  'SavedMeal',
  'SavedMealLine',
  'PlanItem',
  'PlanItemCompletion',
  'MedicalDocument',
  'DoctorAppointment',
  'ScoreDaySnapshot',
  'FoodPhotoRequestLog',
  'HealthCondition',
];

test('every ledger model is created by the migration', () => {
  const missing = LEDGER_MODELS.filter((m) => !migration.includes(`"${m}"`));
  assert.deepEqual(
    missing,
    [],
    `migration does not create: ${missing.join(', ')} - the schema has them and the DB will not`,
  );
});

test('every ledger column is in the migration, not just in the schema', () => {
  const drifted = [];
  for (const model of LEDGER_MODELS) {
    const cols = migrationColumns(model);
    if (!cols) continue; // covered by the test above
    for (const field of schemaFields(model)) {
      if (!cols.has(field)) drifted.push(`${model}.${field}`);
    }
  }
  assert.deepEqual(
    drifted,
    [],
    `schema columns missing from the migration: ${drifted.join(', ')}. ` +
      'The generated Prisma Client would send these and Postgres would reject them at runtime.',
  );
});

// The two tests above walk a hand-picked list, which is fine for the models the
// ledger migration introduced and quietly wrong for everything since. 13 of 48
// models were covered; the other 35 were unchecked, and that is exactly where the
// drift was hiding: HealthReport and ReportExtraction were in the schema with no
// migration at all (so the lab-report path failed on "relation does not exist"),
// and CyclePhaseEntry had a @updatedAt column its CREATE TABLE never made (so any
// write to it failed). None of it was a ledger model.
//
// Every model, no list to maintain. This is a superset of the two above rather
// than a replacement: they name the ledger models directly when something moves,
// which reads better in a failure than "one of 48".
const ALL_MODELS = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);

test('every model in the schema is created by the migrations', () => {
  const missing = ALL_MODELS.filter((m) => !migrationColumns(m));
  assert.deepEqual(
    missing,
    [],
    `no migration creates these models: ${missing.join(', ')}. A model that only ` +
      'exists in schema.prisma is a runtime error waiting for its first caller, not ' +
      'a table - the generated Client sends queries to a relation that is not there.',
  );
});

test('every column of every model in the schema is created by the migrations', () => {
  const drifted = [];
  for (const model of ALL_MODELS) {
    const cols = migrationColumns(model);
    if (!cols) continue; // reported by the test above
    for (const field of schemaFields(model)) {
      if (!cols.has(field)) drifted.push(`${model}.${field}`);
    }
  }
  assert.deepEqual(
    drifted,
    [],
    `schema columns missing from the migrations: ${drifted.join(', ')}. The ` +
      'generated Prisma Client would send these and Postgres would reject them at ' +
      'runtime - and for an @updatedAt column that means the first write fails, not ' +
      'the first read.',
  );
});

test('the migration creates no column the schema does not have', () => {
  // The reverse direction. An extra column is usually harmless, but a renamed
  // field leaves one behind here and Prisma will never populate it again.
  const orphans = [];
  for (const model of LEDGER_MODELS) {
    const cols = migrationColumns(model);
    const fields = schemaFields(model);
    if (!cols || !fields.size) continue;
    for (const col of cols) {
      if (!fields.has(col)) orphans.push(`${model}.${col}`);
    }
  }
  assert.deepEqual(orphans, [], `migration has columns the schema dropped: ${orphans.join(', ')}`);
});

test('the food sign-off columns are in the migration, not only the schema', () => {
  // Added after the migration was first written, and the failure mode is
  // specific: signoff.js writes verifiedBy, and if the column is only in the
  // schema every sign-off fails on a deployed database while working locally
  // against a regenerated client.
  const cols = migrationColumns('FoodItem');
  assert.ok(cols, 'FoodItem table not found in the migration');
  for (const field of ['source', 'verified', 'verifiedBy', 'verifiedAt', 'reviewNote']) {
    assert.ok(cols.has(field), `migration is missing FoodItem."${field}"`);
  }
});

// The enums this migration is responsible for. The schema also holds the
// workout-domain enums (WorkoutType, LoggingType, CyclePhase, ...) which
// predate it and live in another migration - asserting on those would be
// asserting against a file that is not supposed to mention them.
const LEDGER_ENUMS = [
  'Sex', 'HealthGoalType', 'ActivityLevel', 'DietPattern', 'MealSlot',
  'FoodLogSource', 'TargetSource', 'PlanItemKind', 'PlanItemOrigin',
  'BiometricMetric',
];

test('every ledger enum value in the schema reaches the migration', () => {
  const missing = [];
  for (const name of LEDGER_ENUMS) {
    const body = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(body, `enum ${name} is missing from the schema`);
    const values = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\w+$/.test(l));
    assert.ok(values.length, `enum ${name} has no values`);
    for (const v of values) {
      if (!migration.includes(`'${v}'`)) missing.push(`${name}.${v}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `enum values absent from the migration: ${missing.join(', ')}. ` +
      'An enum in the schema but not in the DB rejects the first write that uses it.',
  );
});

test('the migration defines each ledger enum, not just its values', () => {
  // A value can appear in the migration inside a comment or an unrelated
  // statement while the CREATE TYPE itself is missing.
  const missing = LEDGER_ENUMS.filter((n) => !migration.includes(`"${n}"`));
  assert.deepEqual(missing, [], `migration does not create these enum types: ${missing.join(', ')}`);
});

test('the FoodLogSource enum has no value the service cannot write', () => {
  // The service's FOOD_LOG_SOURCES allowlist and the enum have to agree. They
  // drifted once: logFood defaulted to source 'manual', which is not a member,
  // so a caller that omitted it got a Prisma enum error as a 500.
  const body = schema.match(/enum FoodLogSource \{([\s\S]*?)\n\}/)[1];
  const values = body.split('\n').map((l) => l.trim()).filter((l) => /^\w+$/.test(l));

  const constants = readFileSync(
    join(here, '..', 'services', 'ledger', 'constants.js'),
    'utf8',
  );
  const list = constants.match(/FOOD_LOG_SOURCES = \[([^\]]*)\]/)[1];
  const allowlist = list.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);

  assert.deepEqual(
    [...allowlist].sort(),
    [...values].sort(),
    'FOOD_LOG_SOURCES and the FoodLogSource enum disagree',
  );

  const defaultSource = constants.match(/DEFAULT_FOOD_LOG_SOURCE = '(\w+)'/)[1];
  assert.ok(
    values.includes(defaultSource),
    `default source '${defaultSource}' is not a FoodLogSource value`,
  );
});

// Parses `name: value,` lines out of one of the flat marker maps in
// biometricService, ignoring comments and blank lines.
function markerKeys(source, mapName) {
  const body = source.match(new RegExp(`${mapName} = \\{([\\s\\S]*?)\\n\\}`))[1];
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w]+:/.test(l))
    .map((l) => l.split(':')[0].trim());
}

test('every BiometricMetric is writable, and writable metrics exist in the enum', () => {
  // Three lists have to agree, and until 2026-10-04 nobody checked:
  //
  //   enum BiometricMetric  what the database will store
  //   METRIC_UNITS          what the HTTP layer accepts (biometricController
  //                         derives its METRICS allow-list from this)
  //   METRIC_BOUNDS         what validateMetricValue will accept a value for,
  //                         and returns "Unknown metric" for anything missing
  //
  // BIOLOGICAL_TARGETS defined clinical ranges for four blood markers that were
  // in none of the first two. Nothing errored: computeBiologicalScore looked
  // each stored marker up, missed, and returned null, so the biological 60% of
  // the blended score contributed nothing for anyone. A null that reads as
  // "no data yet" is not something a test finds by accident.
  const body = schema.match(/enum BiometricMetric \{([\s\S]*?)\n\}/)[1];
  const values = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\w+$/.test(l));

  const service = readFileSync(join(here, '..', 'services', 'biometricService.js'), 'utf8');
  const units = markerKeys(service, 'METRIC_UNITS');
  const bounds = markerKeys(service, 'METRIC_BOUNDS');

  assert.deepEqual(
    [...units].sort(),
    [...values].sort(),
    'METRIC_UNITS and the BiometricMetric enum disagree: a metric in one and not ' +
      'the other is either accepted by the DB and refused by the API, or accepted ' +
      'by the API and refused by the database',
  );

  assert.deepEqual(
    [...bounds].sort(),
    [...values].sort(),
    'METRIC_BOUNDS and the BiometricMetric enum disagree: validateMetricValue ' +
      'returns "Unknown metric" for a metric with no range, so such a metric ' +
      'would be advertised by the allow-list and reject every write',
  );
});

test('every BIOLOGICAL_TARGETS key the score engine can reach is a real metric', () => {
  // The other direction: a target the engine looks up but no metric can ever be
  // stored as is dead scoring weight. This is the half that produced the
  // all-zero biological score - BIOLOGICAL_TARGETS named four markers the schema
  // could not store.
  const body = schema.match(/enum BiometricMetric \{([\s\S]*?)\n\}/)[1];
  const values = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\w+$/.test(l));

  const constants = readFileSync(
    join(here, '..', 'services', 'ledger', 'constants.js'),
    'utf8',
  );
  const targets = constants.match(/BIOLOGICAL_TARGETS = \{([\s\S]*?)\n\};/)[1];
  // Indentation-aware on purpose: each marker maps to a nested target object, so
  // matching `name:` anywhere in the body would pick up idealMax/warningMax/unit
  // as though they were markers. Top-level keys sit at exactly two spaces.
  const scored = targets
    .split('\n')
    .map((l) => l.match(/^ {2}([\w]+):/))
    .filter(Boolean)
    .map((m) => m[1]);

  const unreachable = scored.filter((m) => !values.includes(m));
  assert.deepEqual(
    unreachable,
    [],
    `BIOLOGICAL_TARGETS names markers the schema cannot store: ${unreachable.join(', ')}. ` +
      'computeBiologicalScore skips any marker with no target, so these silently ' +
      'contribute nothing to the blended score.',
  );
});
