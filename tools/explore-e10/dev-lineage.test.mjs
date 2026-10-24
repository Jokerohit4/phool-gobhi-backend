import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeDevFixture } from './dev-lineage.mjs';
import { parentCommit } from './migration-inputs.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fixture = () => {
  const value = { kind: 'captured-dev-auth-schema-and-shared-history', parentCommit,
    historySchema: 'public', privacy: { noAccountRows: true, noDatabaseUrl: true },
    schemaSql: 'CREATE TABLE "auth"."CollectibleFind" (id integer);',
    historyRows: [{ id: 'genuine-id', checksum: 'c', finished_at: '2026-10-01T00:00:00+00:00',
      migration_name: 'old', logs: null, rolled_back_at: null, started_at: '2026-10-01T00:00:00+00:00', applied_steps_count: 1 }] };
  value.schemaSqlSha256 = sha(value.schemaSql);
  value.historySha256 = sha(JSON.stringify(value.historyRows));
  return value;
};
const encode = value => gzipSync(JSON.stringify(value)).toString('base64');

test('metadata clone preserves complete history fields and validates capture hashes', () => {
  const value = fixture();
  assert.deepEqual(decodeDevFixture(encode(value)), value);
  assert.throws(() => decodeDevFixture(encode({ ...value, historySha256: 'tampered' })));
  assert.throws(() => decodeDevFixture(encode({ ...value, schemaSqlSha256: 'tampered' })));
});

test('fixture cannot carry account data, DB credentials, different lineage or oversized content', () => {
  for (const patch of [{ privacy: { noAccountRows: false, noDatabaseUrl: true } },
    { historySchema: 'auth' }, { parentCommit: 'another-source' },
    { extra: 'postgresql://user:password@live/db' }]) {
    assert.throws(() => decodeDevFixture(encode({ ...fixture(), ...patch })));
  }
  const value = fixture();
  value.schemaSql += '\nINSERT INTO auth."User" VALUES (1);';
  value.schemaSqlSha256 = sha(value.schemaSql);
  assert.throws(() => decodeDevFixture(encode(value)));
  assert.throws(() => decodeDevFixture('x'.repeat(47001)));
});

test('unknown extra history fields cannot silently become a different evidence class', () => {
  const value = fixture();
  value.historyRows[0].userToken = 'unexpected';
  value.historySha256 = sha(JSON.stringify(value.historyRows));
  assert.throws(() => decodeDevFixture(encode(value)));
});
