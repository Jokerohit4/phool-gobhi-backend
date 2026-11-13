// Hosted-only, additional disposable lineage. This never repairs or replaces raw replay.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { writeReviewPackage, reviewInputs, parentCommit, candidateCommit, forwardNames } from '../explore-e2/provisioning-inputs.mjs';
import { stageBootstrap, stageForward, baselineMigration, bootstrapName, bootstrapDatabases } from './bootstrap-inputs.mjs';
import { redact } from './redact.mjs';

export async function rehearseBootstrap({ root, runtime, container, prisma, env, urlFor, password, checks }) {
  assert.match(container, /^explore-e10-[0-9a-f]{12}$/);
  for (const database of bootstrapDatabases) {
    const uri = new URL(urlFor(database));
    assert.equal(uri.hostname, '127.0.0.1'); assert.equal(uri.pathname, `/${database}`);
    assert.equal(uri.username, 'postgres'); assert.equal(uri.password, password);
    assert.match(uri.port, /^[0-9]+$/);
  }
  const sha256 = data => createHash('sha256').update(data).digest('hex');
  const write = (name, data) => writeFileSync(resolve(runtime, name), redact(typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', [password]));
  const provenance = { kind: 'additional-disposable-bootstrap-baseline', parentCommit, forwardInputCommit: candidateCommit,
    rawHistoricalGate: 'independent; never waived or reclassified by this lane', genuineHistoricalRowsPreserved: false,
    productionLineageSafetyEstablished: false, node: process.version, bootstrapName, forwardNames };
  const ready = [];
  let files, renderedSql;
  function deploy(stage, database, phase) {
    const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', resolve(stage, 'schema.prisma')],
      { cwd: root, env: { ...env, DATABASE_URL: urlFor(database) }, encoding: 'utf8', timeout: 180000 });
    write(`bootstrap-${database}-${phase}.local.log`, (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''));
    if (result.error || result.status !== 0) throw new Error(`Disposable bootstrap ${database}/${phase} failed; inspect preserved log`);
  }
  async function history(client) {
    const { rows } = await client.query(`SELECT format('%I.%I',schemaname,tablename) AS qualified FROM pg_tables
      WHERE tablename='_prisma_migrations' AND schemaname IN ('auth','public')`);
    assert.equal(rows.length, 1, 'one real Prisma history table required');
    return { table: rows[0].qualified, rows: (await client.query(`SELECT to_jsonb(h) AS row FROM ${rows[0].qualified} h ORDER BY migration_name,id`)).rows.map(r => r.row) };
  }
  async function authState(client) {
    const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='auth'
      AND tablename NOT LIKE 'Explore%' AND tablename NOT IN ('CollectibleFind','_prisma_migrations') ORDER BY tablename`)).rows;
    const data = {};
    for (const { tablename } of tables) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      data[tablename] = (await client.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM auth.${quoted} t`)).rows[0].rows;
    }
    // The intentionally removed predecessor's owned sequence is excluded, all others retained.
    const sequences = (await client.query(`SELECT s.* FROM pg_sequences s WHERE s.schemaname='auth' AND NOT EXISTS (
      SELECT 1 FROM pg_class seq JOIN pg_namespace n ON n.oid=seq.relnamespace
      JOIN pg_depend d ON d.objid=seq.oid AND d.deptype IN ('a','i') JOIN pg_class t ON t.oid=d.refobjid
      WHERE n.nspname='auth' AND t.relname='CollectibleFind' AND seq.relname=s.sequencename) ORDER BY s.sequencename`)).rows;
    return { data, sequences };
  }
  try {
    // Exact pinned Git bytes, not the mutable E2 checkout. Refuses existing output.
    const packageDirectory = resolve(runtime, `bootstrap-review-${container}`);
    const manifest = writeReviewPackage(root, packageDirectory);
    ({ files } = reviewInputs(root));
    for (const name of forwardNames) {
      assert.deepEqual(readFileSync(resolve(root, 'services/auth-service/prisma/migrations', name, 'migration.sql')),
        files.find(f => f.path === `forward/${name}/migration.sql`).bytes, 'current forward bytes must equal approved pinned input');
    }
    write('bootstrap-input-manifest.json', manifest);
    const installed = JSON.parse(readFileSync(resolve(root, 'services/auth-service/node_modules/prisma/package.json')));
    const lock = readFileSync(resolve(root, 'services/auth-service/package-lock.json'));
    assert.equal(installed.version, '6.8.2');
    assert.equal(JSON.parse(lock).packages['node_modules/prisma'].version, installed.version);
    Object.assign(provenance, { inputManifestSha256: sha256(readFileSync(resolve(packageDirectory, 'manifest.json'))),
      prismaVersion: installed.version, prismaCliSha256: sha256(readFileSync(prisma)), authLockSha256: sha256(lock),
      prismaPackageJsonSha256: sha256(readFileSync(resolve(root, 'services/auth-service/node_modules/prisma/package.json'))),
      parentSchemaSha256: sha256(files.find(f => f.path === 'parent.prisma').bytes),
      renderCommand: [process.execPath, prisma, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', resolve(packageDirectory, 'parent.prisma'), '--script'],
      deployCommandTemplate: [process.execPath, prisma, 'migrate', 'deploy', '--schema', '<recorded per-lane stage>/schema.prisma'] });
    const rendered = spawnSync(process.execPath, [prisma, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', resolve(packageDirectory, 'parent.prisma'), '--script'],
      { cwd: root, env, encoding: 'utf8', timeout: 180000 });
    write('bootstrap-render.local.log', (rendered.status === 0 ? '' : (rendered.stdout ?? '')) + (rendered.stderr ?? '') + (rendered.error?.message ?? ''));
    if (rendered.error || rendered.status !== 0) throw new Error('Pinned parent SQL render failed');
    renderedSql = rendered.stdout;
    assert.ok(renderedSql.includes('"auth"."CollectibleFind"'));
    assert.ok(!renderedSql.includes('"auth"."Explore'), 'render only the pre-feature parent');
    writeFileSync(resolve(runtime, 'bootstrap-parent.rendered.sql'), renderedSql);
    writeFileSync(resolve(runtime, 'bootstrap-baseline.migration.sql'), baselineMigration(renderedSql));
    Object.assign(provenance, { renderedSqlSha256: sha256(renderedSql), executedBaselineSqlSha256: sha256(baselineMigration(renderedSql)),
      forwardSql: forwardNames.map(name => ({ name, sha256: sha256(files.find(f => f.path === `forward/${name}/migration.sql`).bytes) })) });
    provenance.result = 'inputs-and-render-prepared';
  } catch (error) {
    provenance.result = 'failed'; provenance.error = redact(error.message, [password]);
    for (const database of bootstrapDatabases) checks.push({ check: `${database}: additional disposable bootstrap/baseline`, result: 'failed', reason: 'input/render preparation failed' });
    write('bootstrap-provenance.json', provenance);
    return ready;
  }
  write('bootstrap-provenance.json', provenance);
  for (const database of bootstrapDatabases) {
    const receipt = { kind: provenance.kind, database, rawHistoricalGate: 'separate and still required',
      genuineHistoricalRowsPreserved: false, productionLineageSafetyEstablished: false, historyBeforeBootstrap: null };
    const client = new pg.Client({ connectionString: urlFor(database), connectionTimeoutMillis: 3000, query_timeout: 5000 });
    try {
      await client.connect();
      const objects = (await client.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`)).rows;
      assert.deepEqual(objects, [], 'new database must have no user objects before bootstrap');
      receipt.verifiedEmpty = true;
      receipt.historyBeforeBootstrap = [];
      const stage = resolve(runtime, `bootstrap-stage-${database}-${container}`);
      receipt.stageDirectory = stage;
      stageBootstrap(stage, files, renderedSql);
      deploy(stage, database, 'baseline');
      receipt.historyAfterBootstrap = await history(client);
      assert.equal(receipt.historyAfterBootstrap.rows.length, 1);
      const [baseline] = receipt.historyAfterBootstrap.rows;
      assert.equal(baseline.migration_name, bootstrapName);
      assert.equal(baseline.checksum, provenance.executedBaselineSqlSha256);
      assert.ok(baseline.finished_at && !baseline.rolled_back_at);
      assert.equal((await client.query('SELECT count(*)::int AS count FROM auth."CollectibleFind"')).rows[0].count, 0);
      if (database === 'e10_bootstrap_populated') {
        await client.query(`INSERT INTO auth."User" (id,role,type,"updatedAt") VALUES (9001,'customer','general',now());
          SELECT setval(pg_get_serial_sequence('auth."User"','id'),9001,true);
          INSERT INTO auth."CollectibleFind" ("userId","collectibleId") VALUES (9001,'e10-explicit-bootstrap')`);
      }
      receipt.legacyRowsBefore = (await client.query('SELECT count(*)::int AS count FROM auth."CollectibleFind"')).rows[0].count;
      assert.equal(receipt.legacyRowsBefore, database === 'e10_bootstrap_populated' ? 1 : 0);
      receipt.authStateBefore = await authState(client);
      receipt.historyBeforeUpgrade = await history(client);
      stageForward(stage, files);
      deploy(stage, database, 'forward');
      receipt.historyAfterUpgrade = await history(client);
      const priorIds = new Set(receipt.historyBeforeUpgrade.rows.map(row => row.id));
      assert.deepEqual(receipt.historyAfterUpgrade.rows.filter(row => priorIds.has(row.id)), receipt.historyBeforeUpgrade.rows);
      assert.deepEqual(receipt.historyAfterUpgrade.rows.map(row => row.migration_name), [bootstrapName, ...forwardNames]);
      for (const row of receipt.historyAfterUpgrade.rows) {
        assert.ok(row.finished_at && !row.rolled_back_at);
        const expected = row.migration_name === bootstrapName ? provenance.executedBaselineSqlSha256 : provenance.forwardSql.find(f => f.name === row.migration_name).sha256;
        assert.equal(row.checksum, expected);
      }
      assert.equal((await client.query(`SELECT to_regclass('auth."CollectibleFind"') AS legacy`)).rows[0].legacy, null);
      receipt.authStateAfter = await authState(client);
      assert.deepEqual(receipt.authStateAfter, receipt.authStateBefore, 'non-legacy auth data and sequences must remain unchanged');
      receipt.result = 'passed'; ready.push(database);
    } catch (error) {
      receipt.result = 'failed'; receipt.error = redact(error.message, [password]);
      try { receipt.historyAtFailure = await history(client); } catch { receipt.historyAtFailure = null; }
    } finally {
      await client.end().catch(() => {});
      write(`bootstrap-${database}.local.json`, receipt);
      checks.push({ check: `${database}: additional disposable bootstrap/baseline`, result: receipt.result,
        evidenceClass: 'executed snapshot baseline lineage, not historical replay', log: `.runtime/bootstrap-${database}.local.json` });
    }
  }
  return ready;
}
