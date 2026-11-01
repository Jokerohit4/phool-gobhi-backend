// Item 13: the WorkoutSession (userId, templateId, startedAt) index exists in BOTH
// the Prisma schema and a migration, under the name Prisma derives, so
// `migrate deploy` creates what the schema (and the drift audit) expect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma');
const NAME = 'WorkoutSession_userId_templateId_startedAt_idx';

test('schema declares the index on WorkoutSession', () => {
  const schema = readFileSync(join(root, 'schema.prisma'), 'utf8');
  const model = schema.slice(schema.indexOf('model WorkoutSession {'));
  const body = model.slice(0, model.indexOf('\n}'));
  assert.match(body, /@@index\(\[userId, templateId, startedAt\]\)/);
});

test('a migration creates it idempotently, in the health schema, newest in order', () => {
  const dirs = readdirSync(join(root, 'migrations'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const mine = dirs.find((d) => d.endsWith('_workout_session_template_index'));
  assert.ok(mine, 'migration folder exists');
  assert.match(mine, /^\d{14}_/);
  assert.ok(dirs.indexOf(mine) >= dirs.length - 2 || mine >= "20261101130000", 'sorts after the migrations that existed when it was written');
  const sql = readFileSync(join(root, 'migrations', mine, 'migration.sql'), 'utf8');
  assert.ok(sql.includes(`CREATE INDEX IF NOT EXISTS "${NAME}" ON "health"."WorkoutSession"("userId", "templateId", "startedAt")`));
});
