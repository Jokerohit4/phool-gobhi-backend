// Read-only remote dev inventory. Does not migrate, clone, resolve or rewrite DBs.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentCommit, forwardMigrations, baselineFiles } from './migration-inputs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = name => `"${name.replaceAll('"', '""')}"`;
const timestamp = value => value instanceof Date ? value.toISOString() : value;

export function classifyHistory(rows, historical, forward) {
  const issues = [];
  const expected = new Map([...historical, ...forward].map(row => [row.name, row]));
  const successful = new Set();
  for (const row of rows) {
    const source = expected.get(row.migration_name);
    if (!source) issues.push({ kind: 'unrecognized_migration', name: row.migration_name });
    else if (!source.checksums.includes(row.checksum)) {
      issues.push({ kind: 'checksum_mismatch', name: row.migration_name });
    }
    if (!row.finished_at && !row.rolled_back_at) issues.push({ kind: 'unfinished_migration', name: row.migration_name });
    if (row.rolled_back_at) issues.push({ kind: 'rolled_back_history_requires_review', name: row.migration_name });
    if (row.finished_at && !row.rolled_back_at) {
      if (successful.has(row.migration_name)) issues.push({ kind: 'duplicate_success', name: row.migration_name });
      successful.add(row.migration_name);
    }
  }
  for (const row of historical) {
    if (!successful.has(row.name)) issues.push({ kind: 'missing_historical_success', name: row.name });
  }
  const appliedForward = forward.filter(row => successful.has(row.name)).map(row => row.name);
  if (appliedForward.length && appliedForward.length !== forward.length) issues.push({ kind: 'partial_forward_application' });
  return { issues, appliedForward, pendingForward: forward.filter(row => !successful.has(row.name)).map(row => row.name) };
}

export function pinnedInputs(repositoryRoot = root) {
  const sql = baselineFiles(repositoryRoot).filter(file => file.path.endsWith('/migration.sql'));
  const entry = (name, bytes) => ({ name, checksums: [...new Set([
    digest(bytes), digest(bytes.toString('utf8').replaceAll('\r\n', '\n')),
    digest(bytes.toString('utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')),
  ])] });
  const git = args => {
    const result = spawnSync('git', ['-c', `safe.directory=${repositoryRoot.replaceAll('\\', '/').replace(/\/$/, '')}`, ...args], { cwd: repositoryRoot });
    if (result.status !== 0) throw new Error('Pinned source unavailable');
    return result.stdout;
  };
  return {
    historical: sql.map(file => entry(file.path.split('/')[0], file.bytes)),
    forward: forwardMigrations.map(name => entry(name, git(['show', `HEAD:services/auth-service/prisma/migrations/${name}/migration.sql`]))),
    sourceCommit: git(['rev-parse', 'HEAD']).toString().trim(),
  };
}

export async function inventoryDev(client, { schema, historical, forward }) {
  if (!schema || schema.includes('\0')) throw new Error('Invalid schema');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    const setting = await client.query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('server_version_num') AS server_version");
    if (setting.rows[0]?.read_only !== 'on') throw new Error('Read-only transaction required');
    const ledgers = await client.query("SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='_prisma_migrations' AND c.relkind IN ('r','p') ORDER BY n.nspname");
    const ledgerSchemas = ledgers.rows.map(row => row.schema);
    const rows = ledgerSchemas.includes(schema)
      ? (await client.query(`SELECT * FROM ${quote(schema)}."_prisma_migrations" ORDER BY started_at,id`)).rows : [];
    const history = classifyHistory(rows, historical, forward);
    if (!ledgerSchemas.includes(schema)) history.issues.push({ kind: 'configured_ledger_absent', schema });
    // Logs can contain sensitive SQL/error context. Retain hashes only.
    const ledger = rows.map(row => {
      const complete = Object.fromEntries(Object.entries(row).sort().map(([key, value]) => [key, timestamp(value)]));
      const { logs, ...safe } = complete;
      return { ...safe, fullRowSha256: digest(JSON.stringify(complete)), logsSha256: logs == null ? null : digest(String(logs)) };
    });
    const objects = (await client.query("SELECT to_regclass('auth.\"User\"')::text AS auth_user, to_regclass('auth.\"CollectibleFind\"')::text AS legacy, to_regclass('auth.\"ExploreProgress\"')::text AS explore")).rows[0];
    const columns = (await client.query("SELECT table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='auth' ORDER BY table_name,ordinal_position")).rows;
    const constraints = (await client.query("SELECT c.relname AS table_name,x.conname,x.contype,pg_get_constraintdef(x.oid) AS definition FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' ORDER BY c.relname,x.conname")).rows;
    const indexes = (await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='auth' ORDER BY tablename,indexname")).rows;
    const triggers = (await client.query("SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname")).rows;
    const enums = (await client.query("SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='auth' ORDER BY t.typname,e.enumsortorder")).rows;
    const sequences = (await client.query("SELECT sequencename,data_type::text,start_value,min_value,max_value,increment_by,cycle,last_value FROM pg_sequences WHERE schemaname='auth' ORDER BY sequencename")).rows;
    const counts = {};
    if (objects.auth_user) counts.authUser = (await client.query('SELECT count(*)::text AS count FROM auth."User"')).rows[0].count;
    if (objects.legacy) counts.legacyCollectible = (await client.query('SELECT count(*)::text AS count FROM auth."CollectibleFind"')).rows[0].count;
    if (!objects.auth_user) history.issues.push({ kind: 'auth_user_absent' });
    if (history.pendingForward.length === forward.length && (!objects.legacy || objects.explore)) history.issues.push({ kind: 'predecessor_schema_mismatch' });
    return { transactionReadOnly: true, serverVersion: setting.rows[0].server_version,
      configuredLedgerSchema: schema, ledgerSchemas, ledger, history, objects, counts,
      schemaFingerprint: digest(JSON.stringify({ columns, constraints, indexes, triggers, enums })),
      metadata: { columns, constraints, indexes, triggers, enums, sequences },
      result: history.issues.length ? 'blocked' : 'inventory-compatible-requires-isolated-upgrade-rehearsal',
      upgradeExecuted: false, readyForDevMerge: false };
  } finally {
    await client.query('ROLLBACK');
  }
}

export function readDevSecret(run = spawnSync) {
  const args = [
    'secrets', 'versions', 'access', 'latest', '--secret=auth-service-secrets-dev', '--project=phool-gobhi', '--quiet',
  ];
  // Windows needs a command interpreter for .cmd. This is a fixed command:
  // no credentials, user arguments or output paths are interpolated into it.
  const result = run(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'gcloud',
    process.platform === 'win32' ? ['/d', '/s', '/c', `gcloud.cmd ${args.join(' ')}`] : args,
    { encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false,
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' } });
  if (result.status !== 0) throw new Error('dev_secret_access_unavailable');
  try {
    const url = JSON.parse(result.stdout).DATABASE_URL;
    const parsed = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error();
    return { url, schema: parsed.searchParams.get('schema') || 'public' };
  } catch (_) { throw new Error('dev_secret_database_url_invalid'); }
}

async function main() {
  const output = resolve(process.argv[2] || '');
  const owned = relative(resolve(root, 'tools/explore-e10/.runtime'), output);
  if (!process.argv[2] || !owned || owned.startsWith('..') || isAbsolute(owned)) throw new Error('Output must be a new file in tools/explore-e10/.runtime');
  if (existsSync(output)) throw new Error('Refusing to replace existing audit evidence');
  const receipt = { kind: 'read-only-dev-baseline-audit', recordedAt: new Date().toISOString(),
    auditToolSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    parentCommit, ...pinnedInputs(), result: 'blocked', readyForDevMerge: false, upgradeExecuted: false };
  let client;
  try {
    const { url, schema } = readDevSecret();
    const { default: pg } = await import('pg');
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, query_timeout: 15000, application_name: 'explore_dev_merge_readonly_audit' });
    await client.connect();
    Object.assign(receipt, await inventoryDev(client, { schema, ...receipt }));
  } catch (error) {
    const known = ['dev_secret_access_unavailable', 'dev_secret_database_url_invalid'];
    receipt.blocker = known.includes(error.message) ? error.message : 'readonly_connection_or_inventory_unavailable';
    // Never print a DB URL, raw gcloud output, migration logs or driver error.
  } finally { if (client) await client.end().catch(() => {}); }
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: receipt.result, blocker: receipt.blocker ?? null, readyForDevMerge: false, output }));
  if (receipt.result === 'blocked') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
