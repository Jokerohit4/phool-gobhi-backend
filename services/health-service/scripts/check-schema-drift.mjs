#!/usr/bin/env node
// Audits prisma/schema.prisma against a live database and reports every place
// they disagree: enums (presence and values), tables, columns, and foreign keys.
//
// WHY THIS EXISTS
//
// test/schemaMigrationParity.test.js answers "does the schema match the
// migrations?". This answers "does the database match the schema?", which is a
// different question with different failure modes, and the second one is the one
// that reaches a user:
//
//   - A migration written but never applied (a failed run, a deploy that skipped
//     it, an environment whose deploy path never included the service).
//   - A table created outside a migration - by hand, by a db push, by an import.
//   - A migration that applied cleanly to one environment and not another.
//
// None of those are visible to a static comparison, because the migrations are
// correct in all three cases. It is the database that is behind.
//
// WHAT THIS CAUGHT
//
// On dev, 2026-10-04, immediately before the drift fixes that shipped alongside
// this file:
//
//   HealthReport, ReportExtraction   declared in the schema, created by no
//                                    migration at all (48 models, 46 tables).
//                                    The lab-report path failed on
//                                    `relation "health"."HealthReport" does not
//                                    exist`.
//   CyclePhaseEntry.updatedAt        declared `@updatedAt`, missing from its
//                                    CREATE TABLE. Prisma sends @updatedAt
//                                    columns in every INSERT and UPDATE, so the
//                                    first write to that table would fail.
//   ReportStatus                    never created.
//
// None of the three had been reached in production traffic, which is the only
// reason they were still there. Each took seconds to find and would have taken
// hours to find from a stack trace.
//
// WHY NOT IN CI
//
// It needs a real DATABASE_URL, so unlike the parity test it cannot gate a pull
// request. Run it against an environment when you want to know what is actually
// in that environment:
//
//   DEV_DATABASE_URL=... node scripts/check-schema-drift.mjs
//
// The env var is named DEV_ on purpose, following scripts/verify-erasure-live.mjs
// in auth-service: a script that reads DATABASE_URL picks up whatever the shell
// happens to have, and on this service that is how you end up pointed at prod by
// accident.
//
// This script only ever runs SELECTs and never writes, so pointing it at prod to
// get a diff is harmless. Read-only is the reason it is allowed to name prod at
// all - do not copy that leniency into anything that writes.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DEV_DATABASE_URL = process.env.DEV_DATABASE_URL;
if (!DEV_DATABASE_URL) {
  console.error('need DEV_DATABASE_URL');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = process.argv[2] || join(here, '..', 'prisma', 'schema.prisma');
const SCHEMA = 'health';

const schema = readFileSync(schemaPath, 'utf8');

// Prisma builtin scalar types. A field typed as anything else is either an enum
// (which is a column) or a relation (which is not), so the two must be told
// apart before anything is compared - the same distinction the parity test makes.
const SCALARS = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes', 'BigInt',
]);

const models = new Map();
for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  models.set(m[1], m[2]);
}
const enums = new Map();
for (const e of schema.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
  // Enum bodies are bare identifiers, one per line; anything with a type is a
  // Prisma attribute line and not a value.
  const vals = e[2].split('\n').map((l) => l.trim()).filter((l) => /^\w+$/.test(l));
  enums.set(e[1], vals);
}

/** Scalar columns declared for a model, keyed by Prisma field name. */
function schemaColumns(body) {
  const cols = new Set();
  for (const line of body.split('\n')) {
    // A comment line cannot match: `//` is not \w. A relation field is skipped by
    // type - relation targets are model names, which are neither a scalar nor an
    // enum name.
    const f = line.match(/^ {2}(\w+)\s+([\w]+)/);
    if (!f) continue;
    if (line.includes('@relation')) continue;
    if (SCALARS.has(f[2]) || enums.has(f[2])) cols.add(f[1]);
  }
  return cols;
}

// `sslmode` is dropped from the connection string because `ssl` is set
// explicitly below, and leaving both makes pg-connection-string print a
// SECURITY WARNING about sslmode=require on every single run. The behaviour is
// unchanged - rejectUnauthorized:false is what sslmode=require meant - but a tool
// that greets every invocation with a security warning is a tool people learn to
// scroll past.
function withoutSslMode(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url; // not a parseable URL; hand it to pg unchanged and let it complain
  }
}

const client = new pg.Client({
  connectionString: withoutSslMode(DEV_DATABASE_URL),
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const q = async (sql, params = []) => (await client.query(sql, params)).rows;

// Guard against pointing at the wrong database. Against a database where this
// schema has never been migrated, every single model reads as missing, and the
// output is technically correct and completely useless.
const tableCount = (await q(
  `SELECT COUNT(*)::int AS n FROM information_schema.tables
   WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [SCHEMA],
))[0].n;
if (tableCount === 0) {
  console.error(`no tables in schema "${SCHEMA}" - is this the right database?`);
  await client.end();
  process.exit(2);
}

// --- enums: presence and values -------------------------------------------
const dbEnums = new Map((await q(
  `SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS vals
   FROM pg_type t
   JOIN pg_enum e ON e.enumtypid = t.oid
   JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = $1
   GROUP BY t.typname`, [SCHEMA],
)).map((r) => [r.name, r.vals]));

// --- tables ----------------------------------------------------------------
const dbTables = new Set((await q(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [SCHEMA],
)).map((r) => r.table_name));

// --- columns ---------------------------------------------------------------
const dbCols = new Map();
for (const r of await q(
  `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
  [SCHEMA],
)) {
  if (!dbCols.has(r.table_name)) dbCols.set(r.table_name, new Set());
  dbCols.get(r.table_name).add(r.column_name);
}

// --- foreign keys ----------------------------------------------------------
// Keyed by column name rather than by constraint name: the question is "does the
// column that holds this reference have its foreign key", which is what breaks a
// write, and it stays meaningful even when the constraint was renamed.
const dbFkCols = new Set((await q(
  `SELECT kcu.column_name FROM information_schema.table_constraints tc
   JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`, [SCHEMA],
)).map((r) => r.column_name));

await client.end();

// --- compare ---------------------------------------------------------------
const problems = [];

const missingEnums = [];
const mismatchedEnums = [];
for (const [name, want] of enums) {
  if (!dbEnums.has(name)) {
    missingEnums.push(name);
    continue;
  }
  const have = dbEnums.get(name);
  const added = want.filter((v) => !have.includes(v));
  if (added.length) mismatchedEnums.push(`${name} (+${added.join(', ')})`);
}

const missingTables = [...models.keys()].filter((m) => !dbTables.has(m));

const missingCols = [];
for (const [model, body] of models) {
  if (!dbTables.has(model)) continue; // reported above; no point listing its columns
  const have = dbCols.get(model) || new Set();
  for (const col of schemaColumns(body)) {
    if (!have.has(col)) missingCols.push(`${model}.${col}`);
  }
}

const declaredFkCols = [...schema.matchAll(/@relation\(fields: \[(\w+)\]/g)].map((m) => m[1]);
const missingFks = declaredFkCols.filter((c) => !dbFkCols.has(c));

if (missingEnums.length) problems.push(`${missingEnums.length} enum(s) missing: ${missingEnums.join(', ')}`);
if (mismatchedEnums.length) problems.push(`enum value drift: ${mismatchedEnums.join('; ')}`);
if (missingTables.length) problems.push(`${missingTables.length} table(s) missing: ${missingTables.join(', ')}`);
if (missingCols.length) problems.push(`${missingCols.length} column(s) missing: ${missingCols.join(', ')}`);
if (missingFks.length) problems.push(`${missingFks.length} foreign key(s) missing: ${missingFks.join(', ')}`);

// --- report ----------------------------------------------------------------
const line = (label, ok, detail) =>
  console.log(`  ${ok ? 'ok  ' : 'DRIFT'}  ${label.padEnd(28)} ${detail}`);

console.log(`schema: ${schemaPath}`);
console.log(`db:     schema "${SCHEMA}", ${tableCount} tables\n`);

line('enums', !missingEnums.length && !mismatchedEnums.length,
  `${enums.size} in schema, ${dbEnums.size} in db`
  + (missingEnums.length ? `, missing ${missingEnums.join(', ')}` : '')
  + (mismatchedEnums.length ? `, drift ${mismatchedEnums.join('; ')}` : ''));
line('tables', !missingTables.length,
  `${models.size} in schema, ${dbTables.size} in db`
  + (missingTables.length ? `, missing ${missingTables.join(', ')}` : ''));
line('columns', !missingCols.length,
  missingCols.length ? `missing ${missingCols.join(', ')}` : 'all present');
line('foreign keys', !missingFks.length,
  `${declaredFkCols.length} declared`
  + (missingFks.length ? `, missing ${missingFks.join(', ')}` : ''));

// A table present in the database and absent from the schema is worth a line of
// its own. It is not drift this script can fix and not drift that breaks a query,
// but it does mean something wrote to this database that the schema does not
// describe - usually a hand-run CREATE TABLE or an abandoned experiment.
const orphans = [...dbTables].filter((t) => !models.has(t));
if (orphans.length) {
  console.log(`\n  note: ${orphans.length} table(s) in the database are not in the schema:`);
  for (const t of orphans) console.log(`        ${t}`);
}

console.log(problems.length ? `\nDRIFT:\n  ${problems.join('\n  ')}` : '\nno drift');
process.exit(problems.length ? 1 : 0);
