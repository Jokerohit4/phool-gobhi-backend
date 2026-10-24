// Captures schema and migration metadata only. No account rows or DB writes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { readDevSecret, pinnedInputs, inventoryDev } from './dev-baseline-audit.mjs';
import { parentCommit } from './migration-inputs.mjs';
import { redact } from './redact.mjs';
import { restoreCapturedIndexDefinitions } from './dev-lineage.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const output = resolve(process.argv[2] || '');
const owned = relative(resolve(root, 'tools/explore-e10/.runtime'), output);
if (!process.argv[2] || !owned || owned.startsWith('..') || isAbsolute(owned)) throw new Error('Use a new directory under .runtime');
mkdirSync(output); // refuses existing evidence
const inputs = pinnedInputs(root);
const { url, schema } = readDevSecret();
if (schema !== 'public') throw new Error('Reviewed fixture requires the discovered shared public ledger');
const readonly = new URL(url);
readonly.searchParams.set('options', `${readonly.searchParams.get('options') || ''} -c default_transaction_read_only=on`);
const client = new pg.Client({ connectionString: readonly.href, connectionTimeoutMillis: 8000, query_timeout: 15000 });
const run = (args, env = process.env) => {
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error('Read-only capture subprocess failed; no raw output emitted');
  return result.stdout;
};
try {
  await client.connect();
  const inventory = await inventoryDev(client, { schema, ...inputs, repositoryRoot: root });
  if (inventory.history.issues.length) throw new Error('Dev lineage inventory has unresolved issues');
  async function history() {
    return (await client.query('SELECT to_jsonb(h) AS row FROM public._prisma_migrations h ORDER BY id')).rows.map(r => r.row);
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const before = await history();
  const sequences = [];
  for (const sequence of inventory.metadata.sequences) {
    const name = sequence.sequencename;
    const values = (await client.query(`SELECT last_value::text,is_called FROM auth."${name.replaceAll('"', '""')}"`)).rows[0];
    sequences.push({ name, ...values });
  }
  await client.query('ROLLBACK');
  const parent = run(['git', '-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`, 'show', `${parentCommit}:services/auth-service/prisma/schema.prisma`]);
  const datasource = resolve(output, 'parent.prisma');
  writeFileSync(datasource, parent, { flag: 'wx' });
  const renderedSql = run([process.execPath, resolve(root, 'services/auth-service/node_modules/prisma/build/index.js'),
    'migrate', 'diff', '--from-empty', '--to-schema-datasource', datasource, '--script'],
    { ...process.env, DATABASE_URL: readonly.href });
  // Prisma 6 renders illegal ASC options on captured GIN indexes. Restore exact
  // pg_indexes definitions for every index, preserving the actual schema.
  const capturedIndexes = restoreCapturedIndexDefinitions(renderedSql, inventory.metadata.indexes);
  const sql = capturedIndexes.sql;
  if (!sql.includes('CREATE SCHEMA IF NOT EXISTS "auth"') || !sql.includes('"auth"."CollectibleFind"') || sql.includes('"auth"."Explore')) {
    throw new Error('Unexpected pre-feature auth schema capture');
  }
  if (/\b(?:INSERT INTO|COPY)\b/.test(sql)) throw new Error('Schema capture must contain no account rows');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const after = await history();
  await client.query('ROLLBACK');
  const finalInventory = await inventoryDev(client, { schema, ...inputs, repositoryRoot: root });
  if (JSON.stringify(before) !== JSON.stringify(after) || finalInventory.schemaFingerprint !== inventory.schemaFingerprint) {
    throw new Error('Schema/history changed during capture; retry to a new directory');
  }
  if (redact(JSON.stringify(before)) !== JSON.stringify(before) || redact(sql) !== sql) {
    throw new Error('Capture contains credential-shaped diagnostics; refused export');
  }
  const fixture = { kind: 'captured-dev-auth-schema-and-shared-history', capturedAt: new Date().toISOString(),
    indexDdlSource: 'exact pg_indexes.indexdef', indexDefinitionsRestored: capturedIndexes.replacements,
    rawRenderedSqlSha256: sha(renderedSql), capturedIndexDefinitionsSha256: sha(JSON.stringify(inventory.metadata.indexes)),
    parentCommit, sourceCommit: inputs.sourceCommit, historySchema: schema,
    schemaSql: sql, schemaSqlSha256: sha(sql), historyRows: before,
    historySha256: sha(JSON.stringify(before)), sequences,
    originalCounts: inventory.counts, schemaFingerprint: inventory.schemaFingerprint,
    retiredAttempts: inventory.history.retiredAttempts, foreignHistoricalSourceProofs: inventory.history.foreignHistoricalSourceProofs,
    privacy: { noAccountRows: true, noDatabaseUrl: true },
    scope: 'actual dev auth schema and complete genuine shared migration rows; synthetic account data in rehearsal only' };
  const encoded = gzipSync(JSON.stringify(fixture)).toString('base64');
  if (encoded.length > 47000) throw new Error('Metadata fixture exceeds temporary GitHub-secret capacity');
  writeFileSync(resolve(output, 'fixture.b64'), encoded, { flag: 'wx' });
  writeFileSync(resolve(output, 'capture-receipt.json'), JSON.stringify({ ...fixture,
    schemaSql: undefined, historyRows: undefined, sequences: undefined,
    historyRowCount: before.length, encodedBytes: encoded.length, encodedSha256: sha(encoded),
    completeHistoryRowHashes: before.map(row => ({ id: row.id, sha256: sha(JSON.stringify(row)) })) }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: 'captured-read-only', output, historyRows: before.length,
    encodedBytes: encoded.length, schemaSqlSha256: sha(sql), historySha256: fixture.historySha256, accountRowsCopied: 0 }));
} finally { await client.end().catch(() => {}); }
