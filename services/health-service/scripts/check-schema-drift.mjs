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

// SSL handling.
//
// The database this script is normally pointed at is a managed Postgres that
// requires TLS and presents a certificate this machine does not have, so
// `rejectUnauthorized: false` is the default and stays that way for any URL that
// does not say otherwise.
//
// What changed is that an EXPLICIT sslmode in the URL is now honoured. Forcing
// `ssl` unconditionally meant the script could not connect to a local or CI
// Postgres at all - "The server does not support SSL connections" - so the one
// place it could be run automatically was the one place it could not run. A
// caller who wrote sslmode=disable means it, and a read-only audit script has
// nothing to protect either way.
//
// `sslmode` is dropped from the string handed to pg when we are supplying the
// `ssl` option ourselves, because leaving both makes pg-connection-string print
// a SECURITY WARNING on every single run. A tool that greets every invocation
// with a security warning is a tool people learn to scroll past.
function sslOptionsFor(url) {
  let mode = null;
  try {
    mode = new URL(url).searchParams.get('sslmode');
  } catch {
    return { ssl: { rejectUnauthorized: false }, connectionString: url };
  }
  if (mode === 'disable') {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return { ssl: false, connectionString: u.toString() };
  }
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  return { ssl: { rejectUnauthorized: false }, connectionString: u.toString() };
}

const { connectionString, ssl } = sslOptionsFor(DEV_DATABASE_URL);
const client = new pg.Client({ connectionString, ssl });

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

// --- column defaults ---------------------------------------------------------
//
// Why this section exists: the four drift items this script could not see for
// months were all about defaults and indexes. A default the schema does not
// declare, and an index the schema declares and the database never got, are
// both invisible to a column-existence check - the column is present either way.
// So this script reported "no drift" against a database that disagreed with the
// schema in four places, for as long as it existed.
//
// The direction matters and both are reported. An undeclared default is a
// column that lies about being written (a write that forgets the field still
// gets a plausible value). A declared-but-absent index is a query that
// full-scans. Neither breaks on deploy; both cost something later.
const dbDefaults = new Map();
for (const r of await q(
  `SELECT table_name, column_name, column_default FROM information_schema.columns
   WHERE table_schema = $1 AND column_default IS NOT NULL`, [SCHEMA],
)) {
  dbDefaults.set(`${r.table_name}.${r.column_name}`, r.column_default);
}

// What Prisma generates for each kind of @default, so a schema default can be
// recognised without hard-coding the SQL each one produces.
const PRISMA_DEFAULTS = [
  [/^nextval\(/i, 'autoincrement()'],
  [/^CURRENT_TIMESTAMP/i, 'now()'],
  [/^true$/i, 'true'],
  [/^false$/i, 'false'],
];

// Declared column defaults, read off the model body the same way columns are.
function schemaDefaults(model, body) {
  const out = new Map();
  for (const line of body.split('\n')) {
    const f = line.match(/^ {2}(\w+)\s+[\w]+.*@default\(([^)]*)\)/);
    if (!f) continue;
    if (line.includes('@relation')) continue;
    out.set(`${model}.${f[1]}`, f[2].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

// What the database has, normalised to the same vocabulary, so the comparison is
// on meaning rather than on the exact string Postgres chose to print.
function normaliseDefault(raw) {
  for (const [re, name] of PRISMA_DEFAULTS) if (re.test(raw)) return name;
  // A quoted string literal in either form.
  const s = raw.replace(/^'(.*)'::.*$/, '$1').replace(/^"(.*)"$/, '$1');
  return s;
}

const unexpectedDefaults = [];
const missingDefaults = [];
for (const [model, body] of models) {
  if (!dbTables.has(model)) continue;
  const declared = schemaDefaults(model, body);
  for (const [key, want] of declared) {
    if (!dbDefaults.has(key)) missingDefaults.push(`${key} (@default(${want}))`);
  }
}
for (const [key, raw] of dbDefaults) {
  const table = key.split('.')[0];
  if (!models.has(table)) continue;
  const declared = schemaDefaults(table, models.get(table));
  if (!declared.has(key)) {
    // Auto-increment columns are implied by @id and by every autoincrement()
    // relation, so their sequence defaults are not worth reporting.
    if (/^nextval\(/i.test(raw)) continue;
    unexpectedDefaults.push(`${key} (${normaliseDefault(raw)})`);
  }
}

// --- indexes -----------------------------------------------------------------
//
// Index names are derived by Prisma from the model and the column list, so a
// missing index is named rather than just counted. Declared as
// @@index([a, b]) / @@unique([a]) and matched against the real definition.
const dbIndexes = new Map();
for (const r of await q(
  `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1`, [SCHEMA],
)) {
  if (!dbIndexes.has(r.tablename)) dbIndexes.set(r.tablename, new Map());
  dbIndexes.get(r.tablename).set(r.indexname, r.indexdef);
}

// Column list out of an indexdef, e.g. 'CREATE INDEX "x" ON health.t USING btree (a, "b")'
function indexColumns(def) {
  const m = def.match(/\(([^)]*)\)\s*$/);
  if (!m) return [];
  return m[1].split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

// Prisma's generated name for an index: <Model>_<col>_<col>_idx / _key.
function indexNameFor(model, cols, kind) {
  return `${model}_${cols.join('_')}_${kind === 'unique' ? 'key' : 'idx'}`;
}

function declaredIndexes(body) {
  const out = [];
  // Line by line, and anchored at the start of the line, because a comment that
  // NAMES an index is not a declaration of one. The schema comment on
  // NutritionTarget explains why `@@index([userId])` is deliberately absent, and
  // that sentence matched a whole-body regex and reported the index as missing -
  // the exact inverse of the drift being looked for. A parser that reads prose
  // as configuration is worse than one that reads nothing.
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*@@(index|unique)\(\[([^\]]+)\]/);
    if (!m) continue;
    const cols = m[2].split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
    out.push({ kind: m[1], cols });
  }
  return out;
}

const missingIndexes = [];
for (const [model, body] of models) {
  if (!dbTables.has(model)) continue;
  const have = dbIndexes.get(model) || new Map();
  for (const { kind, cols } of declaredIndexes(body)) {
    const want = indexNameFor(model, cols, kind);
    if (have.has(want)) continue;
    // Fall back to a column-list match, because a hand-authored migration is
    // free to name its index anything at all and a wrong name is not a missing
    // index.
    const wanted = cols.join(',');
    const found = [...have.entries()].some(
      ([, def]) => indexColumns(def).join(',') === wanted && /UNIQUE/i.test(def) === (kind === 'unique'),
    );
    if (!found) missingIndexes.push(`${model} ${kind} [${cols.join(', ')}]`);
  }
}

// --- compare ---------------------------------------------------------------
//
// Disconnected here rather than straight after the first batch of queries, so
// that every read below happens on an open client. The connection is released
// before anything is printed, and this script never writes either way.
await client.end();
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
if (missingIndexes.length) problems.push(`${missingIndexes.length} index(es) missing: ${missingIndexes.join('; ')}`);
if (unexpectedDefaults.length) {
  problems.push(`${unexpectedDefaults.length} column default(s) the schema does not declare: ${unexpectedDefaults.join('; ')}`);
}
if (missingDefaults.length) problems.push(`${missingDefaults.length} column default(s) missing: ${missingDefaults.join('; ')}`);

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
line('indexes', !missingIndexes.length,
  missingIndexes.length ? `missing ${missingIndexes.join('; ')}` : 'all present');
line('column defaults', !unexpectedDefaults.length && !missingDefaults.length,
  (unexpectedDefaults.length ? `undeclared ${unexpectedDefaults.join('; ')}` : '')
  + (unexpectedDefaults.length && missingDefaults.length ? '; ' : '')
  + (missingDefaults.length ? `missing ${missingDefaults.join('; ')}` : '')
  || 'as declared');

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
