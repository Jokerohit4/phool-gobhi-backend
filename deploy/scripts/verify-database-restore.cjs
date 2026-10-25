// Live source is read-only. Full dump stays in an owned temporary directory,
// is restored only into an owned local Docker database, and is never uploaded.
const { execFileSync, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const environment = process.argv[2];
if (!['dev', 'prod'].includes(environment) || process.platform === 'win32') {
  throw Error('Usage on a Linux Docker runner: node deploy/scripts/verify-database-restore.cjs dev|prod');
}
const work = mkdtempSync(path.join(tmpdir(), 'pg-restore-drill-'));
const container = 'pg-restore-drill-' + randomBytes(6).toString('hex');
const password = randomBytes(32).toString('hex');
const receipt = { environment, startedAt: new Date().toISOString(), sourceReadOnly: true,
  sourceSnapshotConsistent: true, dumpUploaded: false, restored: false, cleanup: false };
let source, owned = false;
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 180000, ...options });
  if (result.error || result.status !== 0) throw Error(`${binary} operation failed (${result.status ?? result.error?.code})`);
  return result.stdout?.trim();
}
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const digestQuery = (schema, table) => `SELECT count(*)::text AS count,
  coalesce(md5(string_agg(hash, '' ORDER BY hash)), md5('')) AS digest
  FROM (SELECT md5(to_jsonb(row)::text) AS hash FROM ${quote(schema)}.${quote(table)} row) rows`;

(async () => {
  const secret = JSON.parse(execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest',
    `--secret=auth-service-secrets-${environment}`, '--project=phool-gobhi'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const uri = new URL(secret.DATABASE_URL);
  if (!uri.hostname.endsWith('.neon.tech') || uri.hostname.includes('-pooler')) {
    throw Error('Expected a direct Neon source connection');
  }
  source = new Client({ connectionString: secret.DATABASE_URL, connectionTimeoutMillis: 15000 });
  await source.connect();
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await source.query("SET LOCAL statement_timeout='60s'");
  await source.query("SET LOCAL TIME ZONE 'UTC'");
  const snapshot = (await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
  const tables = (await source.query(`SELECT schemaname,tablename FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%'
    ORDER BY schemaname,tablename`)).rows;
  const expected = [];
  for (const table of tables) expected.push({ ...table,
    ...(await source.query(digestQuery(table.schemaname, table.tablename))).rows[0] });
  run('docker', ['create', '--pull=never', '--name', container,
    '--label', 'purpose=backend-restore-drill', '-e', 'POSTGRES_PASSWORD', 'postgres:17'],
  { env: { ...process.env, POSTGRES_PASSWORD: password } });
  owned = true;
  run('docker', ['start', container]);
  for (let attempt = 0; ; attempt++) {
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' });
    if (ready.status === 0) break;
    if (attempt >= 60) throw Error('Disposable restore target did not become ready');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const liveEnv = { ...process.env, PGHOST: uri.hostname, PGPORT: uri.port || '5432',
    PGUSER: decodeURIComponent(uri.username), PGPASSWORD: decodeURIComponent(uri.password),
    PGDATABASE: uri.pathname.slice(1), PGSSLMODE: 'verify-full', PGCONNECT_TIMEOUT: '15' };
  const dumpFile = path.join(work, 'backup.dump');
  const fd = openSync(dumpFile, 'wx', 0o600);
  try {
    run('docker', ['exec', ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGCONNECT_TIMEOUT'].flatMap(k => ['-e', k]),
      container, 'pg_dump', '--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot],
    { env: liveEnv, stdio: ['ignore', fd, 'pipe'] });
  } finally { closeSync(fd); }
  await source.query('ROLLBACK');
  await source.end(); source = null;
  run('docker', ['cp', dumpFile, container + ':/tmp/backup.dump']);
  run('docker', ['exec', container, 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl',
    '--username=postgres', '--dbname=postgres', '/tmp/backup.dump']);
  for (const table of expected) {
    const sql = `SET TIME ZONE 'UTC'; SELECT row_to_json(result) FROM (${digestQuery(table.schemaname, table.tablename)}) result;`;
    const result = JSON.parse(run('docker', ['exec', container, 'psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', 'postgres', '-c', sql]));
    if (result.count !== table.count || result.digest !== table.digest) {
      throw Error(`Restore integrity mismatch in ${table.schemaname}.${table.tablename}`);
    }
  }
  receipt.restored = true;
  receipt.tablesVerified = expected.length;
  receipt.rowsVerified = expected.reduce((sum, table) => sum + Number(table.count), 0);
  receipt.serverMajor = 17;
})().catch(error => {
  receipt.error = error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]');
  process.exitCode = 1;
}).finally(async () => {
  if (source) { await source.query('ROLLBACK').catch(() => {}); await source.end().catch(() => {}); }
  try {
    if (owned) run('docker', ['rm', '--force', '--volumes', container]);
    const resolved = path.resolve(work);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('pg-restore-drill-')) throw Error('Unexpected temporary path');
    rmSync(resolved, { recursive: true });
    receipt.cleanup = true;
  } catch { receipt.cleanup = false; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  const output = process.env.RESTORE_RECEIPT || path.join(tmpdir(), `backend-restore-${environment}.json`);
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
});
