// Owns its container and databases. Never consumes DATABASE_URL or .env files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = resolve(root, 'tools/explore-e10/.runtime');
mkdirSync(runtime, { recursive: true });
const name = `explore-e10-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const evidence = { startedAt: new Date().toISOString(), container: name, image: 'postgres:16', checks: [] };
const cleanEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|appdata|localappdata|programdata)$/i.test(key))),
  NODE_ENV: 'test', SECRETS_JSON: '', K_SERVICE: '',
  JWT_SECRET: 'e10-local-only', INTERNAL_API_KEY: 'e10-local-only', ANALYTICS_DATABASE_URL: '',
  ANALYTICS_PROVIDER: 'none', DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid' };
function run(bin, args, env = cleanEnv) {
  const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args.slice(0, 3).join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
function mark(check, detail = {}) { evidence.checks.push({ check, result: 'passed', ...detail }); }
let owned = false;
try {
  for (const file of ['.env', 'services/auth-service/.env', 'services/auth-service/prisma/.env',
    'services/booking-service/.env', 'services/booking-service/prisma/.env', 'tools/explore-e10/.runtime/.env']) {
    if (existsSync(resolve(root, file))) throw new Error(`Use an isolated candidate without environment files: ${file}`);
  }
  run('docker', ['info', '--format', '{{.ServerVersion}}']);
  // A missing image is an explicit prerequisite; never pulls or accesses a registry.
  evidence.imageId = run('docker', ['image', 'inspect', 'postgres:16', '--format', '{{.Id}}']);
  run('docker', ['run', '--pull=never', '--detach', '--name', name,
    '--label', 'purpose=explore-e10-disposable', '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', '127.0.0.1::5432', 'postgres:16']);
  owned = true;
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
  try { for (const database of ['e10_fresh', 'e10_old_chain', 'e10_upgrade', 'e10_upgrade_empty', 'e10_runtime']) await admin.query(`CREATE DATABASE ${database}`); }
  finally { await admin.end(); }
  const urlFor = database => adminUrl.replace(/postgres$/, database);
  const prisma = resolve(root, 'services/auth-service/node_modules/prisma/build/index.js');
  const authPath = 'services/auth-service/prisma/schema.prisma';
  const sqlHash = text => createHash('sha256').update(text).digest('hex');

  // Full historical chain is deliberately attempted as-is; never rewrite/resolve old migrations.
  const fresh = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', authPath],
    { cwd: root, env: { ...cleanEnv, DATABASE_URL: urlFor('e10_fresh') }, encoding: 'utf8', timeout: 180000 });
  writeFileSync(resolve(runtime, 'fresh-migrate.local.log'), fresh.stdout + fresh.stderr);
  evidence.checks.push({ check: 'fresh historical migration chain', result: fresh.status === 0 ? 'passed' : 'failed',
    log: '.runtime/fresh-migrate.local.log' });

  // Independent old-table upgrade: exact parent schema, baseline with Prisma, then only forward E2 SQL.
  // This is a schema-snapshot baseline, explicitly distinct from the fresh historical-chain check.
  const parentSchema = run('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`,
    'show', '5214fa8dd8242093e542bd89a169dcf9321753b2:services/auth-service/prisma/schema.prisma']);
  const parentFile = resolve(runtime, 'parent.prisma');
  writeFileSync(parentFile, parentSchema);
  const oldChain = resolve(runtime, 'old-chain');
  mkdirSync(resolve(oldChain, 'migrations'), { recursive: true });
  writeFileSync(resolve(oldChain, 'schema.prisma'), parentSchema);
  const migrationRoot = resolve(root, 'services/auth-service/prisma/migrations');
  for (const entry of readdirSync(migrationRoot)) {
    if (!entry.startsWith('20261023000')) cpSync(resolve(migrationRoot, entry), resolve(oldChain, 'migrations', entry), { recursive: true });
  }
  const oldDeploy = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', resolve(oldChain, 'schema.prisma')],
    { cwd: root, env: { ...cleanEnv, DATABASE_URL: urlFor('e10_old_chain') }, encoding: 'utf8', timeout: 180000 });
  writeFileSync(resolve(runtime, 'old-chain.local.log'), oldDeploy.stdout + oldDeploy.stderr);
  evidence.checks.push({ check: 'old historical chain before E2', result: oldDeploy.status === 0 ? 'passed' : 'failed', log: '.runtime/old-chain.local.log' });
  if (oldDeploy.status === 0) {
    const old = new pg.Client({ connectionString: urlFor('e10_old_chain') }); await old.connect();
    try {
      // Prisma's migration table lives in the connection's default schema (normally public).
      const before = (await old.query('SELECT * FROM _prisma_migrations ORDER BY id')).rows;
      await old.query(`INSERT INTO auth."User" (id,role,type,"updatedAt") VALUES (9001,'customer','general',now());
        INSERT INTO auth."CollectibleFind" ("userId","collectibleId") VALUES (9001,'e10-old-chain')`);
      run(process.execPath, [prisma, 'migrate', 'deploy', '--schema', authPath], { ...cleanEnv, DATABASE_URL: urlFor('e10_old_chain') });
      const ids = before.map(row => row.id);
      const after = (await old.query('SELECT * FROM _prisma_migrations WHERE id = ANY($1::text[]) ORDER BY id', [ids])).rows;
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Historical applied migration rows changed');
      mark('populated old-table upgrade through Prisma deploy; all applied history rows unchanged', { before, after });
    } finally { await old.end(); }
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
    for (const migration of ['20261023000000_exploration_core', '20261023000100_drop_unreleased_collectible_find']) {
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
    mark(`${upgradeDatabase}: old-table snapshot upgrade; baseline migration row unchanged`, { baselineSqlHash: sqlHash(baselineSql), before, after });
  } finally { await upgrade.end(); }
  }

  // Generate isolated clients, never write a source lane's node_modules/.prisma.
  const dependencyLink = resolve(root, 'tools/explore-e10/node_modules');
  if (!existsSync(dependencyLink)) symlinkSync(resolve(root, 'services/auth-service/node_modules'), dependencyLink, 'junction');
  for (const service of ['auth', 'booking']) {
    const schema = readFileSync(resolve(root, `services/${service}-service/prisma/schema.prisma`), 'utf8')
      .replace('provider        = "prisma-client-js"', `provider        = "prisma-client-js"\n  output = "./${service}-client"`);
    const file = resolve(runtime, `${service}.prisma`);
    writeFileSync(file, schema);
    run(process.execPath, [prisma, 'generate', '--schema', file]);
    // Current-schema runtime DB is separate from both migration rehearsal DBs.
    const sql = run(process.execPath, [prisma, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', file, '--script']);
    for (const database of service === 'booking' ? ['e10_runtime', 'e10_upgrade', 'e10_upgrade_empty'] : ['e10_runtime']) {
      const runtimeDb = new pg.Client({ connectionString: urlFor(database) });
      await runtimeDb.connect();
      try { await runtimeDb.query(sql); } finally { await runtimeDb.end(); }
    }
  }
  // Schema diff does not include handwritten immutable triggers. Apply those exact production bytes.
  const coreSql = readFileSync(resolve(root, 'services/auth-service/prisma/migrations/20261023000000_exploration_core/migration.sql'), 'utf8');
  const runtimeDb = new pg.Client({ connectionString: urlFor('e10_runtime') });
  await runtimeDb.connect();
  try {
    await runtimeDb.query(`ALTER TABLE auth."ExploreClaim" ADD CONSTRAINT "ExploreClaim_terminal_outcome"
      CHECK (("receiptId" IS NULL) <> ("reason" IS NULL))`);
    await runtimeDb.query(coreSql.slice(coreSql.indexOf('CREATE FUNCTION')));
  } finally { await runtimeDb.end(); }
  for (const database of ['e10_runtime', 'e10_upgrade', 'e10_upgrade_empty']) {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', 'tools/explore-e10/postgres.test.mjs'],
      { cwd: root, env: { ...cleanEnv, DATABASE_URL: urlFor(database), E10_OWNED_DATABASE: name }, encoding: 'utf8', timeout: 180000 });
    const log = `.runtime/postgres-${database}.local.log`;
    writeFileSync(resolve(root, 'tools/explore-e10', log), result.stdout + result.stderr);
    evidence.checks.push({ check: `${database}: real HTTP/PostgreSQL integration including export/erasure`, result: result.status === 0 ? 'passed' : 'failed', log });
  }
  if (evidence.checks.some(check => check.result !== 'passed')) throw new Error('Rehearsal has failing checks; inspect local logs');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'blocked-or-failed';
  // Do not persist container credentials or a connection URI from diagnostics.
  evidence.error = String(error.message).replaceAll(password, '[redacted]').replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted-db-uri]');
  process.exitCode = 1;
} finally {
  if (owned) {
    try { run('docker', ['rm', '--force', '--volumes', name]); evidence.cleanup = 'owned container and volumes removed'; }
    catch { evidence.cleanup = `FAILED: remove owned container ${name}`; process.exitCode = 1; }
  } else evidence.cleanup = 'no container created';
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(resolve(runtime, 'rehearsal-result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
