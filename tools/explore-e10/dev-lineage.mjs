// Hosted disposable metadata clone. Never receives a live database credential.
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { redact } from './redact.mjs';
import { pinnedInputs, classifyHistory, resolveForeignHistory } from './dev-baseline-audit.mjs';
import { parentCommit, forwardMigrations } from './migration-inputs.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export function decodeDevFixture(encoded) {
  if (!encoded || encoded.length > 47000) throw new Error('Missing or oversized metadata fixture');
  const text = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 1000000 }).toString();
  const fixture = JSON.parse(text);
  assert.equal(fixture.kind, 'captured-dev-auth-schema-and-shared-history');
  assert.equal(fixture.parentCommit, parentCommit);
  assert.equal(fixture.historySchema, 'public');
  assert.deepEqual(fixture.privacy, { noAccountRows: true, noDatabaseUrl: true });
  assert.equal(sha(fixture.schemaSql), fixture.schemaSqlSha256);
  assert.equal(sha(JSON.stringify(fixture.historyRows)), fixture.historySha256);
  assert.ok(fixture.historyRows.length > 0 && fixture.historyRows.length <= 1000);
  assert.ok(fixture.schemaSql.includes('"auth"."CollectibleFind"'));
  assert.ok(!/\b(?:INSERT INTO|COPY|DROP TABLE|TRUNCATE|DELETE FROM)\b/.test(fixture.schemaSql));
  assert.equal(redact(text), text, 'fixture must not contain credential-shaped diagnostics');
  const fields = ['id', 'checksum', 'finished_at', 'migration_name', 'logs', 'rolled_back_at', 'started_at', 'applied_steps_count'].sort();
  for (const row of fixture.historyRows) assert.deepEqual(Object.keys(row).sort(), fields);
  return fixture;
}

export async function rehearseDevLineage({ root, runtime, container, prisma, env, urlFor, password, checks, encoded }) {
  if (!encoded) return false;
  assert.match(container, /^explore-e10-[0-9a-f]{12}$/);
  const database = 'e10_dev_lineage';
  const uri = new URL(urlFor(database));
  assert.equal(uri.hostname, '127.0.0.1');
  assert.equal(uri.pathname, `/${database}`);
  const receipt = { kind: 'actual-dev-schema-and-genuine-history-metadata-clone',
    accountData: 'synthetic only; no live account records copied',
    rawHistoricalReplay: 'separate; unchanged failures remain recorded', result: 'failed' };
  const client = new pg.Client({ connectionString: uri.href });
  const history = async () => (await client.query('SELECT to_jsonb(h) AS row FROM public._prisma_migrations h ORDER BY id')).rows.map(r => r.row);
  async function state() {
    const data = {};
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='auth' AND tablename NOT LIKE 'Explore%' AND tablename<>'CollectibleFind' ORDER BY tablename")).rows;
    for (const { tablename } of tables) {
      data[tablename] = (await client.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM auth."${tablename.replaceAll('"', '""')}" t`)).rows[0].rows;
    }
    const sequences = (await client.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='auth' AND sequencename NOT LIKE 'CollectibleFind%' ORDER BY sequencename")).rows;
    return { data, sequences };
  }
  try {
    receipt.stage = 'validate-captured-metadata';
    const fixture = decodeDevFixture(encoded);
    const inputs = pinnedInputs(root);
    const resolved = resolveForeignHistory(root, inputs.foreign, fixture.historyRows);
    const classification = classifyHistory(fixture.historyRows, inputs.historical, inputs.forward, resolved.foreign);
    assert.deepEqual(classification.issues, []);
    assert.deepEqual(classification.pendingForward, forwardMigrations);
    Object.assign(receipt, { capturedAt: fixture.capturedAt, capturedSource: fixture.sourceCommit,
      schemaSqlSha256: fixture.schemaSqlSha256, capturedHistorySha256: fixture.historySha256,
      capturedHistoryRows: fixture.historyRows.length, sourceSchemaFingerprint: fixture.schemaFingerprint,
      resolvedRetiredAttempts: classification.retiredAttempts,
      foreignHistoricalSourceProofs: resolved.proofs, originalCounts: fixture.originalCounts });
    await client.connect();
    receipt.stage = 'restore-schema-and-genuine-ledger';
    await client.query("SET TIME ZONE 'UTC'");
    await client.query(fixture.schemaSql);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM auth."User"')).rows[0].count, 0);
    await client.query(`CREATE TABLE public._prisma_migrations (
      id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
      migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
    await client.query('INSERT INTO public._prisma_migrations SELECT * FROM jsonb_populate_recordset(NULL::public._prisma_migrations,$1::jsonb)', [JSON.stringify(fixture.historyRows)]);
    const before = await history();
    assert.deepEqual(before, fixture.historyRows, 'every field of every genuine shared ledger row must be preserved in the clone');
    for (const sequence of fixture.sequences) {
      await client.query('SELECT setval($1::regclass,$2::bigint,$3::boolean)', [`auth."${sequence.name.replaceAll('"', '""')}"`, sequence.last_value, sequence.is_called]);
    }
    await client.query(`INSERT INTO auth."User" (id,role,type,"updatedAt") VALUES (9001,'customer','general',now());
      INSERT INTO auth."CollectibleFind" ("userId","collectibleId") VALUES (9001,'e10-dev-lineage-synthetic')`);
    const beforeState = await state();
    receipt.stage = 'prisma-existing-lineage-forward-deploy';
    const deployed = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--schema', 'services/auth-service/prisma/schema.prisma'],
      { cwd: root, env: { ...env, DATABASE_URL: uri.href }, encoding: 'utf8', timeout: 180000 });
    // Never persist raw historical migration logs. Prisma deployment output here
    // contains names/status only, redacted again before artifact collection.
    writeFileSync(resolve(runtime, 'dev-lineage-forward.local.log'), redact((deployed.stdout ?? '') + (deployed.stderr ?? ''), [password]));
    assert.equal(deployed.status, 0, 'existing dev lineage forward deploy must succeed');
    receipt.stage = 'verify-history-data-and-sequences';
    const after = await history();
    const oldIds = new Set(before.map(row => row.id));
    assert.deepEqual(after.filter(row => oldIds.has(row.id)), before, 'all 143 genuine rows, including superseded attempts and foreign services, must remain unchanged');
    const added = after.filter(row => !oldIds.has(row.id));
    assert.deepEqual(added.map(row => row.migration_name).sort(), [...forwardMigrations].sort());
    for (const row of added) {
      assert.ok(row.finished_at && !row.rolled_back_at);
      assert.ok(inputs.forward.find(f => f.name === row.migration_name).checksums.includes(row.checksum));
    }
    assert.equal((await client.query(`SELECT to_regclass('auth."CollectibleFind"') AS legacy`)).rows[0].legacy, null);
    assert.deepEqual(await state(), beforeState, 'non-legacy synthetic auth data and original sequence state must be unchanged');
    Object.assign(receipt, { result: 'passed', genuineHistoryRowsPreserved: before.length,
      historyBeforeSha256: sha(JSON.stringify(before)), retainedHistoryAfterSha256: sha(JSON.stringify(after.filter(row => oldIds.has(row.id)))),
      addedMigrations: added.map(row => ({ name: row.migration_name, checksum: row.checksum })),
      syntheticLegacyRowsRemoved: 1, nonLegacyAuthAndSequencesPreserved: true });
    return true;
  } catch (error) {
    // Assertion messages can contain original migration logs; retain stage only.
    receipt.error = 'dev_lineage_validation_failed';
    return false;
  } finally {
    await client.end().catch(() => {});
    writeFileSync(resolve(runtime, 'dev-lineage-evidence.json'), JSON.stringify(receipt, null, 2) + '\n');
    checks.push({ check: 'actual dev auth schema/shared-history metadata-clone forward upgrade', result: receipt.result,
      evidenceClass: 'captured genuine schema/history, synthetic account data; no live DB writes', log: '.runtime/dev-lineage-evidence.json' });
  }
}
