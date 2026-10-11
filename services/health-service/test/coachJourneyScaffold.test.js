import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import journeyRouter from '../routes/journey.js';
import habitsRouter from '../routes/habits.js';
import contentRouter from '../routes/content.js';

// A2 lands the coach-journey schema and three mount points, and nothing else.
// The migration-vs-schema parity sweep in schemaMigrationParity.test.js already
// proves every model and column reaches the SQL; this file pins the parts that
// sweep cannot see: that the new routers are actually mounted, that they are
// inert, and that the two nullable flips really are nullable.

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');
const healthRoutes = readFileSync(join(here, '..', 'routes', 'health.js'), 'utf8');

function modelBody(name) {
  return schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
}

const NEW_MODELS = [
  'WaterLog',
  'SupplementSchedule',
  'SupplementLog',
  'JourneyProgress',
  'CoachConsent',
  'ExerciseContent',
  'CoachArticle',
];

test('every coach-journey model is declared in the health schema', () => {
  const missing = NEW_MODELS.filter((m) => !modelBody(m));
  assert.deepEqual(missing, [], `schema is missing: ${missing.join(', ')}`);
});

test('every coach-journey model carries @@schema("health")', () => {
  // A model without a schema mapping is applied to the default schema, and the
  // migration creates it in "health" - so the generated client queries a
  // relation that does not exist. This is the one line that is easy to drop.
  const unmapped = NEW_MODELS.filter((m) => !/@@schema\("health"\)/.test(modelBody(m)));
  assert.deepEqual(unmapped, [], `no @@schema("health") on: ${unmapped.join(', ')}`);
});

test('the three nullable additions are nullable', () => {
  // These are the fields the caller-tolerance depends on: kcal is null until a
  // NutritionTarget exists, and a pre-journey PlanItem has no layer.
  assert.match(modelBody('Prescription'), /kcal\s+Int\?/, 'Prescription.kcal must be Int?');
  assert.match(modelBody('Prescription'), /workoutSlots\s+Json\?/, 'Prescription.workoutSlots must be Json?');
  assert.match(modelBody('PlanItem'), /layerKey\s+String\?/, 'PlanItem.layerKey must be String?');
  assert.match(modelBody('Exercise'), /difficulty\s+String\?/, 'Exercise.difficulty must be String?');
});

test('the three coach-journey routers are mounted on the health router', () => {
  for (const name of ['journeyRouter', 'habitsRouter', 'contentRouter']) {
    assert.match(healthRoutes, new RegExp(`router\\.use\\(${name}\\)`), `${name} is not mounted`);
    assert.match(healthRoutes, new RegExp(`import ${name} from`), `${name} is not imported`);
  }
});

test('the mounted routers are inert - no routes registered yet', () => {
  // Empty on purpose in A2. A route appearing here without a B-task is either a
  // mistake or an ungated surface, and either way it should be a deliberate edit
  // that also removes this test.
  for (const [name, router] of [
    ['journey', journeyRouter],
    ['habits', habitsRouter],
    ['content', contentRouter],
  ]) {
    assert.equal(typeof router, 'function', `${name} is not an Express router`);
    assert.equal(router.stack.length, 0, `${name} router already has routes`);
  }
});

test('the migration is additive and opens with a lock_timeout', () => {
  const sql = join(here, '..', 'prisma', 'migrations', '20261016000000_coach_journey', 'migration.sql');
  assert.ok(existsSync(sql), 'the coach-journey migration is missing');
  const body = readFileSync(sql, 'utf8');
  // Comments may precede it; the point is that the timeout is the FIRST
  // statement, before any ALTER or CREATE takes a lock.
  const firstStatement = body.replace(/^\s*--.*$/gm, '').trim();
  assert.match(firstStatement, /^SET lock_timeout = '3s';/, 'the migration must start with SET lock_timeout');
  for (const m of NEW_MODELS) {
    assert.match(body, new RegExp(`CREATE TABLE IF NOT EXISTS "health"\\."${m}"`), `${m} is not created`);
  }
  assert.match(body, /ALTER COLUMN "kcal" DROP NOT NULL/, 'kcal must be made nullable');
  assert.match(body, /ADD COLUMN IF NOT EXISTS "workoutSlots"/, 'workoutSlots must be added');
  assert.match(body, /ADD COLUMN IF NOT EXISTS "layerKey"/, 'layerKey must be added');
  assert.match(body, /ADD COLUMN IF NOT EXISTS "difficulty"/, 'difficulty must be added');
});
