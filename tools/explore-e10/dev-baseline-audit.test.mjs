import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHistory, inventoryDev, readDevSecret } from './dev-baseline-audit.mjs';

const historical = [{ name: 'old', checksums: ['old-hash'] }];
const forward = [{ name: 'new', checksums: ['new-hash'] }];
const row = () => ({ id: 'old-id', migration_name: 'old', checksum: 'old-hash',
  started_at: '2026-01-01', finished_at: '2026-01-02', rolled_back_at: null,
  applied_steps_count: 1, logs: 'must never leave process: private error context' });

test('history mismatches, failed, missing and unknown migrations block compatibility', () => {
  assert.deepEqual(classifyHistory([row()], historical, forward).issues, []);
  for (const rows of [[], [{ ...row(), checksum: 'wrong' }], [{ ...row(), finished_at: null }],
    [{ ...row(), rolled_back_at: '2026-01-03' }], [row(), row()], [row(), { ...row(), migration_name: 'unknown' }]]) {
    assert.ok(classifyHistory(rows, historical, forward).issues.length);
  }
  const partial = classifyHistory([row(), { ...row(), migration_name: 'new', checksum: 'new-hash' }],
    historical, [...forward, { name: 'later', checksums: ['later'] }]);
  assert.ok(partial.issues.some(i => i.kind === 'partial_forward_application'));
});

function fixture({ failAt, readOnly = 'on', ledgerSchemas = ['auth'] } = {}) {
  const queries = [];
  return { queries, async query(sql) {
    queries.push(sql);
    if (failAt && sql.includes(failAt)) throw new Error('private driver failure');
    if (sql.includes('transaction_read_only')) return { rows: [{ read_only: readOnly, server_version: '160000' }] };
    if (sql.includes("c.relname='_prisma_migrations'")) return { rows: ledgerSchemas.map(schema => ({ schema })) };
    if (sql.startsWith('SELECT *')) return { rows: [row()] };
    if (sql.includes('to_regclass')) return { rows: [{ auth_user: 'auth.User', legacy: 'auth.CollectibleFind', explore: null }] };
    if (sql.includes('count(*)')) return { rows: [{ count: '0' }] };
    return { rows: [] };
  } };
}

test('inventory uses only read-only SQL, rolls back and strips migration log contents', async () => {
  const client = fixture();
  const result = await inventoryDev(client, { schema: 'auth', historical, forward });
  assert.equal(client.queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(client.queries.at(-1), 'ROLLBACK');
  assert.ok(client.queries.every(sql => /^(BEGIN|SELECT|SET LOCAL|ROLLBACK)\b/.test(sql)));
  assert.ok(client.queries.every(sql => !/\b(UPDATE|DELETE|INSERT|ALTER|DROP|CREATE|TRUNCATE)\b/.test(sql)));
  assert.equal(result.result, 'inventory-compatible-requires-isolated-upgrade-rehearsal');
  assert.equal(result.readyForDevMerge, false);
  assert.equal(result.upgradeExecuted, false);
  assert.match(result.ledger[0].logsSha256, /^[0-9a-f]{64}$/);
  assert.match(result.ledger[0].fullRowSha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(result).includes('private error context'));
});

test('missing configured ledger never substitutes a different discovered schema', async () => {
  const client = fixture({ ledgerSchemas: ['public', 'health'] });
  const result = await inventoryDev(client, { schema: 'auth', historical, forward });
  assert.equal(result.result, 'blocked');
  assert.ok(result.history.issues.some(i => i.kind === 'configured_ledger_absent'));
  assert.ok(!client.queries.some(sql => sql.startsWith('SELECT *')));
});

test('inventory failure and rejected read-only settings always roll back', async () => {
  for (const options of [{ failAt: 'pg_indexes' }, { readOnly: 'off' }]) {
    const client = fixture(options);
    await assert.rejects(inventoryDev(client, { schema: 'auth', historical, forward }));
    assert.equal(client.queries.at(-1), 'ROLLBACK');
  }
});

test('secret access is pinned to dev, captures output and emits no credential errors', () => {
  const value = readDevSecret((bin, args, options) => {
    assert.ok(args.join(' ').includes('--secret=auth-service-secrets-dev'));
    assert.ok(args.join(' ').includes('--project=phool-gobhi'));
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    return { status: 0, stdout: JSON.stringify({ DATABASE_URL: 'postgresql://u:private@db/x?schema=auth' }) };
  });
  assert.equal(value.schema, 'auth');
  assert.throws(() => readDevSecret(() => ({ status: 1, stdout: 'private', stderr: 'private' })),
    { message: 'dev_secret_access_unavailable' });
  assert.throws(() => readDevSecret(() => ({ status: 0, stdout: 'private invalid JSON' })),
    { message: 'dev_secret_database_url_invalid' });
});
