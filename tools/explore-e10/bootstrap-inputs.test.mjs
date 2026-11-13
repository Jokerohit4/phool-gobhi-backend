import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewInputs, forwardNames } from '../explore-e2/provisioning-inputs.mjs';
import { stageBootstrap, stageForward, baselineMigration, bootstrapName } from './bootstrap-inputs.mjs';

test('disposable staging contains one distinct baseline and exact forward inputs, never historical names', () => {
  const { files } = reviewInputs(fileURLToPath(new URL('../../', import.meta.url)));
  const temporary = mkdtempSync(resolve(tmpdir(), 'e10-bootstrap-inputs-'));
  try {
    // Synthetic SQL only: this test does not render SQL or invoke Prisma/DBs.
    const sql = 'CREATE SCHEMA "auth";';
    for (const lane of ['empty', 'populated']) {
      const stage = resolve(temporary, lane);
      stageBootstrap(stage, files, sql);
      assert.deepEqual(readdirSync(resolve(stage, 'migrations')).sort(), [bootstrapName, 'migration_lock.toml'].sort());
      assert.deepEqual(readFileSync(resolve(stage, `migrations/${bootstrapName}/migration.sql`)), baselineMigration(sql));
      assert.deepEqual(readFileSync(resolve(stage, 'schema.prisma')), files.find(f => f.path === 'parent.prisma').bytes);
      stageForward(stage, files);
      assert.deepEqual(readdirSync(resolve(stage, 'migrations')).sort(), [bootstrapName, 'migration_lock.toml', ...forwardNames].sort());
      for (const name of forwardNames) assert.deepEqual(readFileSync(resolve(stage, `migrations/${name}/migration.sql`)), files.find(f => f.path === `forward/${name}/migration.sql`).bytes);
      assert.throws(() => stageBootstrap(stage, files, sql), /EEXIST/);
      assert.throws(() => stageForward(stage, files), /EEXIST/);
    }
  } finally {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('e10-bootstrap-inputs-'));
    rmSync(temporary, { recursive: true, force: true });
  }
});
