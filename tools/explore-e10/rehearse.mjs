// Owns its container and databases. Never consumes DATABASE_URL or .env files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import { redact } from './redact.mjs';
import { rehearseBootstrap } from './bootstrap.mjs';
import { rehearseDevLineage } from './dev-lineage.mjs';
import { bootstrapDatabases } from './bootstrap-inputs.mjs';
import { baselineFiles, parentCommit, forwardMigrations, telemetryOutcomeConstraint } from './migration-inputs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = resolve(root, 'tools/explore-e10/.runtime');
mkdirSync(runtime, { recursive: true });
const name = `explore-e10-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const evidence = { startedAt: new Date().toISOString(), container: name, image: 'postgres:16', checks: [] };
const cleanEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(home|path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|appdata|localappdata|programdata)$/i.test(key))),
  NODE_ENV: 'test', SECRETS_JSON: '', K_SERVICE: '',
  JWT_SECRET: 'e10-local-only', INTERNAL_API_KEY: 'e10-local-only', ANALYTICS_DATABASE_URL: '',
  ANALYTICS_PROVIDER: 'none', DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid' };
function run(bin, args, env = cleanEnv) {
  const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args.slice(0, 3).join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
function log(file, text) { writeFileSync(resolve(runtime, file), redact(text, [password])); }
function mark(check, detail = {}) { evidence.checks.push({ check, result: 'passed', ...detail }); }
let owned = false;
try {
  for (const file of ['.env', 'services/auth-service/.env', 'services/auth-service/prisma/.env',
    'services/booking-service/.env', 'services/booking-service/prisma/.env', 'tools/explore-e10/.runtime/.env']) {
    if (existsSync(resolve(root, file))) throw new Error(`Use an isolated candidate without environment files: ${file}`);
  }
  evidence.dockerServerVersion = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  // A missing image is an explicit prerequisite; never pulls or accesses a registry.
  evidence.imageId = run('docker', ['image', 'inspect', 'postgres:16', '--format', '{{.Id}}']);
  run('docker', ['create', '--pull=never', '--name', name,
    '--label', 'purpose=explore-e10-disposable', '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', '127.0.0.1::5432', 'postgres:16']);
  owned = true;
  run('docker', ['start', name]);
  const port = run('docker', ['port', name, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Container did not expose a loopback-only PostgreSQL port');
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  let ready = false;
  for (let n = 0; n < 60; n++) {
    const probe = new pg.Client({ connectionString: adminUrl });
    try { await probe.connect(); ready = true; break; }
    catch { await new Promise(r => setTimeout(r, 250)); }
    finally { await probe.end().catch(() => {}); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { for (const database of ['e10_fresh', 'e10_old_chain', 'e10_upgrade', 'e10_upgrade_empty', 'e10_runtime', 'e10_sink', 'e10_dev_lineage', ...bootstrapDatabases]) await admin.query(`CREATE DATABASE ${database}`); }
  finally { await admin.end(); }
  const sinkAdmin = new pg.Client({ connectionString: adminUrl });
  await sinkAdmin.connect();
  try { await sinkAdmin.query("ALTER DATABASE e10_sink SET default_transaction_isolation TO 'repeatable read'"); }
  finally { await sinkAdmin.end(); }
  const urlFor = database => adminUrl.replace(/postgres$/, database);
  const prisma = resolve(root, 'services/auth-service/node_modules/prisma/build/index.js');
  const authPath = 'services/auth-service/prisma/schema.prisma';
  const sqlHash = text => createHash('sha256').update(text).digest('hex');

  async function migrationTable(client) {
    const { rows } = await client.query(`SELECT format('%I.%I', schemaname, tablename) AS qualified
      FROM pg_tables WHERE tablename='_prisma_migrations' AND schemaname IN ('public','auth')`);
    if (rows.length !== 1) throw new Error('Expected one unambiguous native Prisma history table');
    return rows[0].qualified;
  }
  async function verifyForward(database) {
    const client = new pg.Client({ connectionString: urlFor(database) });
    await client.connect();
    try {
      const table = await migrationTable(client);
      const applied = (await client.query(`SELECT migration_name FROM ${table}
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)).rows.map(r => r.migration_name);
      if (forwardMigrations.some(m => !applied.includes(m))) throw new Error('Forward migration missing from applied history');
      const constraints = (await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='auth."ExploreReceiptEvent"'::regclass`)).rows.map(r => r.conname);
      if (!constraints.includes('ExploreReceiptEvent_outcome_check')) throw new Error('Telemetry outcome CHECK absent');
      mark(`${database}: all three forward migrations and native telemetry constraint present`, { applied });
    } finally { await client.end(); }
  }

  // Full historical chain is deliberately attempted as-is; never rewrite/resolve old migrations.
  const fresh = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', authPath],
    { cwd: root, env: { ...cleanEnv, DATABASE_URL: urlFor('e10_fresh') }, encoding: 'utf8', timeout: 180000 });
  log('fresh-migrate.local.log', (fresh.stdout ?? '') + (fresh.stderr ?? '') + (fresh.error?.message ?? ''));
  evidence.checks.push({ check: 'fresh historical migration chain', result: fresh.status === 0 ? 'passed' : 'failed',
    log: '.runtime/fresh-migrate.local.log' });
  if (fresh.status === 0) await verifyForward('e10_fresh');

  // Historical old-table replay is independent of the labelled snapshot baselines below.
  // Preserve every historical migration byte and previously applied history row.
  const parentSchema = run('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`,
    'show', `${parentCommit}:services/auth-service/prisma/schema.prisma`]);
  const parentFile = resolve(runtime, 'parent.prisma');
  writeFileSync(parentFile, parentSchema);
  const oldChain = resolve(runtime, `old-chain-${name}`);
  mkdirSync(resolve(oldChain, 'migrations'), { recursive: true });
  writeFileSync(resolve(oldChain, 'schema.prisma'), parentSchema);
  const baseline = baselineFiles(root);
  evidence.baseline = { parentCommit, files: baseline.map(({path, bytes}) => ({path, sha256: sqlHash(bytes)})) };
  evidence.forwardMigrations = forwardMigrations;
  for (const {path, bytes} of baseline) {
    const file = resolve(oldChain, 'migrations', path);
    mkdirSync(resolve(file, '..'), {recursive: true});
    writeFileSync(file, bytes);
  }
  const oldDeploy = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', resolve(oldChain, 'schema.prisma')],
    { cwd: root, env: { ...cleanEnv, DATABASE_URL: urlFor('e10_old_chain') }, encoding: 'utf8', timeout: 180000 });
  log('old-chain.local.log', (oldDeploy.stdout ?? '') + (oldDeploy.stderr ?? '') + (oldDeploy.error?.message ?? ''));
  evidence.checks.push({ check: 'old historical chain before E2', result: oldDeploy.status === 0 ? 'passed' : 'failed', log: '.runtime/old-chain.local.log' });
  if (oldDeploy.status === 0) {
    const old = new pg.Client({ connectionString: urlFor('e10_old_chain') }); await old.connect();
    try {
      // Discover Prisma's history schema rather than assume a connection search_path.
      const table = await migrationTable(old);
      const before = (await old.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
      await old.query(`INSERT INTO auth."User" (id,role,type,"updatedAt") VALUES (9001,'customer','general',now());
        INSERT INTO auth."CollectibleFind" ("userId","collectibleId") VALUES (9001,'e10-old-chain')`);
      const forward = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', authPath],
        { cwd: root, env: { ...cleanEnv, DATABASE_URL: urlFor('e10_old_chain') }, encoding: 'utf8', timeout: 180000 });
      log('old-forward.local.log', (forward.stdout ?? '') + (forward.stderr ?? '') + (forward.error?.message ?? ''));
      if (forward.status !== 0) throw new Error('Populated old-table forward deployment failed; inspect old-forward.local.log');
      await verifyForward('e10_old_chain');
      const ids = before.map(row => row.id);
      const after = (await old.query(`SELECT * FROM ${table} WHERE id = ANY($1::text[]) ORDER BY id`, [ids])).rows;
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Historical applied migration rows changed');
      mark('populated old-table upgrade through Prisma deploy; all applied history rows unchanged', { before, after });
    } catch (error) {
      evidence.checks.push({ check: 'populated old-table forward upgrade/history retention', result: 'failed',
        error: redact(error.message, [password]), log: '.runtime/old-forward.local.log' });
    } finally { await old.end(); }
  } else {
    evidence.checks.push({ check: 'populated old-table forward upgrade/history retention', result: 'not-executed', reason: 'historical baseline deployment failed' });
  }
  const baselineSql = run(process.execPath, [prisma, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', parentFile, '--script']);
  for (const upgradeDatabase of ['e10_upgrade', 'e10_upgrade_empty']) {
  const upgrade = new pg.Client({ connectionString: urlFor(upgradeDatabase) });
  await upgrade.connect();
  try {
    await upgrade.query(baselineSql);
    await upgrade.query(`CREATE TABLE auth._prisma_migrations (id text PRIMARY KEY, checksum text NOT NULL,
      finished_at timestamptz, migration_name text NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
    // One accurate baseline record; do not pretend the historical chain ran here.
    await upgrade.query(`INSERT INTO auth._prisma_migrations(id, checksum, migration_name, finished_at, applied_steps_count)
      VALUES ('e10-parent-snapshot', $1, 'e10_parent_5214fa8_schema_snapshot', now(), 1)`, [sqlHash(baselineSql)]);
    const before = (await upgrade.query('SELECT * FROM auth._prisma_migrations ORDER BY id')).rows;
    // Populate the predecessor using its real required columns.
    await upgrade.query(`INSERT INTO auth."User" (id, role, type, "updatedAt") VALUES (9001,'customer','general',now())`);
    if (upgradeDatabase === 'e10_upgrade') await upgrade.query(`INSERT INTO auth."CollectibleFind" ("userId", "collectibleId") VALUES (9001,'e10-disposable')`);
    for (const migration of forwardMigrations) {
      const sql = readFileSync(resolve(root, 'services/auth-service/prisma/migrations', migration, 'migration.sql'), 'utf8');
      await upgrade.query('BEGIN');
      try {
        await upgrade.query(sql);
        await upgrade.query(`INSERT INTO auth._prisma_migrations(id,checksum,migration_name,finished_at,applied_steps_count)
          VALUES ($1,$2,$1,now(),1)`, [migration, sqlHash(sql)]);
        await upgrade.query('COMMIT');
      } catch (error) { await upgrade.query('ROLLBACK'); throw error; }
    }
    const after = (await upgrade.query(`SELECT * FROM auth._prisma_migrations WHERE id='e10-parent-snapshot'`)).rows;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Baseline migration history changed');
    const obsolete = (await upgrade.query(`SELECT to_regclass('auth."CollectibleFind"') AS old`)).rows[0].old;
    if (obsolete !== null) throw new Error('Legacy table survives upgrade');
    mark(`${upgradeDatabase}: old-table snapshot upgrade; baseline migration row unchanged`, { baselineSqlHash: sqlHash(baselineSql), forwardMigrations, before, after });
  } finally { await upgrade.end(); }
  }

  // Additional parent-approved disposable lineage; raw replay checks above stay authoritative.
  const bootstrapped = await rehearseBootstrap({ root, runtime, container: name, prisma, env: cleanEnv, urlFor, password, checks: evidence.checks });
  const devLineage = await rehearseDevLineage({ root, runtime, container: name, prisma, env: cleanEnv, urlFor, password, checks: evidence.checks,
    encoded: process.env.E10_DEV_LINEAGE_FIXTURE });
  const nativeDatabases = ['e10_runtime', 'e10_upgrade', 'e10_upgrade_empty', ...bootstrapped, ...(devLineage ? ['e10_dev_lineage'] : [])];
  for (const database of bootstrapDatabases.filter(db => !bootstrapped.includes(db))) {
    evidence.checks.push({ check: `${database}: native Explore/telemetry suite`, result: 'not-executed', reason: 'disposable bootstrap lineage failed' });
  }

  // Generate isolated clients, never write a source lane's node_modules/.prisma.
  const dependencyLink = resolve(root, 'tools/explore-e10/node_modules');
  if (!existsSync(dependencyLink)) symlinkSync(resolve(root, 'services/auth-service/node_modules'), dependencyLink, process.platform === 'win32' ? 'junction' : 'dir');
  for (const service of ['auth', 'booking']) {
    const schema = readFileSync(resolve(root, `services/${service}-service/prisma/schema.prisma`), 'utf8')
      .replace('provider        = "prisma-client-js"', `provider        = "prisma-client-js"\n  output = "./${service}-client"`);
    const file = resolve(runtime, `${service}.prisma`);
    writeFileSync(file, schema);
    run(process.execPath, [prisma, 'generate', '--schema', file]);
    // Current-schema runtime DB is separate from both migration rehearsal DBs.
    const sql = run(process.execPath, [prisma, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', file, '--script']);
    for (const database of service === 'booking' ? nativeDatabases : ['e10_runtime']) {
      const runtimeDb = new pg.Client({ connectionString: urlFor(database) });
      await runtimeDb.connect();
      try { await runtimeDb.query(sql); } finally { await runtimeDb.end(); }
    }
  }
  // Schema diff does not include handwritten immutable triggers. Apply those exact production bytes.
  const coreSql = readFileSync(resolve(root, 'services/auth-service/prisma/migrations/20261023000000_exploration_core/migration.sql'), 'utf8');
  const telemetrySql = readFileSync(resolve(root, 'services/auth-service/prisma/migrations', forwardMigrations[2], 'migration.sql'), 'utf8');
  const runtimeDb = new pg.Client({ connectionString: urlFor('e10_runtime') });
  await runtimeDb.connect();
  try {
    await runtimeDb.query(`ALTER TABLE auth."ExploreClaim" ADD CONSTRAINT "ExploreClaim_terminal_outcome"
      CHECK (("receiptId" IS NULL) <> ("reason" IS NULL))`);
    await runtimeDb.query(telemetryOutcomeConstraint(telemetrySql));
    await runtimeDb.query(coreSql.slice(coreSql.indexOf('CREATE FUNCTION')));
  } finally { await runtimeDb.end(); }
  for (const database of nativeDatabases) {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', 'tools/explore-e10/postgres.test.mjs'],
      { cwd: root, env: { ...cleanEnv, DATABASE_URL: urlFor(database), E10_OWNED_DATABASE: name, E10_SINK_DATABASE_URL: urlFor('e10_sink') }, encoding: 'utf8', timeout: 180000 });
    const log = `.runtime/postgres-${database}.local.log`;
    writeFileSync(resolve(root, 'tools/explore-e10', log), redact((result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''), [password]));
    evidence.checks.push({ check: `${database}: real HTTP/PostgreSQL integration including telemetry delivery and export/erasure`, result: result.status === 0 ? 'passed' : 'failed',
      evidenceClass: database.startsWith('e10_bootstrap_') ? 'additional explicit bootstrap/baseline; not historical replay' : 'existing runtime/snapshot setup', log });
  }
  if (evidence.checks.some(check => check.result !== 'passed')) throw new Error('Rehearsal has failing checks; inspect local logs');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'blocked-or-failed';
  // Do not persist container credentials or a connection URI from diagnostics.
  evidence.error = redact(error.message, [password]);
  process.exitCode = 1;
} finally {
  if (owned) {
    try { run('docker', ['rm', '--force', '--volumes', name]); evidence.cleanup = 'owned container and volumes removed'; }
    catch { evidence.cleanup = `FAILED: remove owned container ${name}`; process.exitCode = 1; }
  } else evidence.cleanup = 'no container created';
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(resolve(runtime, 'rehearsal-result.json'), redact(JSON.stringify(evidence, null, 2), [password]) + '\n');
  console.log(redact(JSON.stringify(evidence, null, 2), [password]));
}
