import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baselineFiles, forwardMigrations, telemetryOutcomeConstraint } from './migration-inputs.mjs';

test('frozen pre-feature tree excludes all forward migrations, including telemetry', () => {
  const files = baselineFiles(fileURLToPath(new URL('../../', import.meta.url)));
  assert.ok(files.length > 20);
  assert.ok(files.some(f => f.path === 'migration_lock.toml'));
  assert.ok(files.every(f => !forwardMigrations.some(m => f.path.startsWith(m + '/'))));
  assert.equal(forwardMigrations.length, 3);
  for (const file of files) assert.ok(Buffer.isBuffer(file.bytes) && file.bytes.length > 0);
});

test('runtime setup extracts the exact approved SQL-only telemetry CHECK', () => {
  const sql = readFileSync(new URL(`../../services/auth-service/prisma/migrations/${forwardMigrations[2]}/migration.sql`, import.meta.url), 'utf8');
  const ddl = telemetryOutcomeConstraint(sql);
  assert.ok(sql.includes(ddl.split(' ADD ')[1]));
  assert.match(ddl, /explore_pickup_saved/);
  assert.match(ddl, /explore_pickup_rejected/);
  assert.throws(() => telemetryOutcomeConstraint(''), /not found/);
});
