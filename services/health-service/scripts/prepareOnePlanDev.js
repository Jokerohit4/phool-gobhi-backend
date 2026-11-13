#!/usr/bin/env node
// Dev release verification around the existing migration. Never use on prod.
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { migrateToOnePlan } from './migrateToOnePlan.js';
import { rebuildPlan } from '../services/plan/rebuildPlan.js';

const MUTATIONS = ['ownAssigned', 'medicineAssigned', 'deactivated', 'autoDeleted'];
const sorted = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const normalize = (rows) => JSON.parse(JSON.stringify(sorted(rows)));

function verifyReport(report, { users, rebuilt = false } = {}) {
  assert.ok(Array.isArray(report.errors), 'Migration did not return an error report');
  assert.equal(report.errors.length, 0, 'Migration reported errors; inspect the saved report before retrying');
  assert.ok(Array.isArray(report.users), 'Migration did not return per-user results');
  const ids = report.users.map((u) => u.userId).sort((a, b) => a - b);
  assert.equal(report.scanned, ids.length, 'Migration did not finish every eligible user');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate migration users');
  if (users) assert.deepEqual(ids, users, 'Eligible population changed during migration');
  if (rebuilt) assert.ok(report.users.every((u) => u.rebuilt === true), 'Not every eligible user was rebuilt');
  return ids;
}

async function retainedRows(prisma, userIds) {
  const [items, ticks] = await Promise.all([
    prisma.planItem.findMany({ where: { userId: { in: userIds }, origin: { in: ['user', 'doctor'] } } }),
    prisma.planItemCompletion.findMany({ where: { userId: { in: userIds }, how: { not: 'auto' } } }),
  ]);
  return {
    items: normalize(items.map(({ updatedAt, ...item }) => item)),
    ticks: normalize(ticks),
  };
}

export async function prepareOnePlanDev(prisma, { apply = false, migrate = migrateToOnePlan, rebuild = rebuildPlan } = {}) {
  const dryRun = await migrate(prisma, { apply: false });
  console.log(`ONE_PLAN_DEV_DRY_RUN=${JSON.stringify(dryRun)}`);
  const users = verifyReport(dryRun);
  if (!apply) return { mode: 'dry-run', dryRun };

  const before = await retainedRows(prisma, users);
  const applied = await migrate(prisma, { apply: true });
  console.log(`ONE_PLAN_DEV_APPLY=${JSON.stringify(applied)}`);
  verifyReport(applied, { users, rebuilt: true });

  const expected = {
    items: before.items.map((item) => ({
      ...item,
      layerKey: item.layerKey ?? (item.origin === 'doctor' ? 'medicine' : 'own'),
    })),
    ticks: before.ticks,
  };
  assert.deepEqual(await retainedRows(prisma, users), expected, 'Migration changed retained items or manual ticks');

  const after = await migrate(prisma, { apply: false });
  verifyReport(after, { users });
  assert.ok(after.users.every((u) => MUTATIONS.every((key) => u[key] === 0)), 'Migration left pending changes');

  const suggestedBefore = normalize(await prisma.planItem.findMany({
    where: { userId: { in: users }, origin: 'suggested', active: true },
  }));
  for (const userId of users) {
    const result = await rebuild(prisma, userId, { reason: 'migrate_verify' });
    assert.equal(result.created, 0, 'Repeated rebuild created more rows');
    assert.equal(result.updated, 0, 'Repeated rebuild changed rows');
    assert.equal(result.deactivated, 0, 'Repeated rebuild deactivated rows');
  }
  assert.deepEqual(normalize(await prisma.planItem.findMany({
    where: { userId: { in: users }, origin: 'suggested', active: true },
  })), suggestedBefore, 'Repeated rebuild changed suggested identities');
  assert.deepEqual(await retainedRows(prisma, users), expected, 'Repeated rebuild changed retained items or ticks');
  return { mode: 'apply', dryRun, applied, after, verified: true, rebuiltUsers: users.length };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.every((arg) => arg === '--apply'), 'Only --apply is supported');
  assert.equal(process.env.ONE_PLAN_MIGRATION_ENV, 'dev', 'Explicit dev migration marker is required');
  assert.equal(process.env.NODE_ENV, 'development', 'Dev runtime is required');
  assert.equal(process.env.CLOUD_RUN_JOB, 'one-plan-dev-data', 'Run only inside the dedicated dev job');
  assert.ok(process.env.DATABASE_URL, 'Dev DATABASE_URL is required');

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const columns = await prisma.$queryRawUnsafe(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'health' AND table_name = 'PlanItem' AND column_name = 'sourceRef'`,
    );
    assert.equal(columns.length, 1, 'One Plan schema migration is missing');
    assert.equal(columns[0].data_type, 'text');
    assert.equal(columns[0].is_nullable, 'YES');
    const indexes = await prisma.$queryRawUnsafe(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'health' AND tablename = 'PlanItem'
       AND indexname = 'PlanItem_userId_sourceRef_idx'`,
    );
    assert.equal(indexes.length, 1, 'One Plan sourceRef index is missing');
    assert.match(indexes[0].indexdef, /\("userId", "sourceRef"\)/);
    // Rebuild reads live flags. An unavailable config must not silently produce
    // an empty desired plan and deactivate the user's existing suggested rows.
    const { isFeatureEnabled } = await import('../middleware/requireFeatureFlag.js');
    assert.equal(await isFeatureEnabled('coachJourney'), true, 'Dev coachJourney must be enabled and readable before migration');
    const report = await prepareOnePlanDev(prisma, { apply: args.includes('--apply') });
    console.log(`ONE_PLAN_DEV_RESULT=${JSON.stringify(report)}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((error) => {
    // Keep DB connection strings and credentials out of runner logs. The
    // structured migration reports above retain per-user migration failures.
    console.error(error instanceof assert.AssertionError
      ? error.message
      : 'Dev migration verification failed. Inspect the preceding reports; no app integration should proceed.');
    process.exit(1);
  });
}
