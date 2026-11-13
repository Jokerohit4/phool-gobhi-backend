// UB5 one-plan data migration tests.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, hostOf, checkTarget, migrateToOnePlan } from '../scripts/migrateToOnePlan.js';

// ---- arg / safety-gate tests ----

test('parseArgs defaults to dry run', () => {
  const opts = parseArgs([]);
  assert.equal(opts.apply, false);
  assert.equal(opts.targetHost, null);
});

test('parseArgs reads --apply and --target-host (inline and separate)', () => {
  assert.deepEqual(parseArgs(['--apply', '--target-host=db.example.com']), {
    apply: true,
    targetHost: 'db.example.com',
  });
  assert.deepEqual(parseArgs(['--apply', '--target-host', 'db.example.com']), {
    apply: true,
    targetHost: 'db.example.com',
  });
});

test('parseArgs rejects unknown arguments', () => {
  assert.throws(() => parseArgs(['--dry-run']), /Unknown argument/);
});

test('hostOf extracts the hostname', () => {
  assert.equal(hostOf('postgresql://user:pass@db.example.com:5432/app'), 'db.example.com');
  assert.throws(() => hostOf('not a url'), /not a valid URL/);
});

test('checkTarget requires DATABASE_URL and a matching --target-host when applying', () => {
  assert.throws(() => checkTarget({ databaseUrl: undefined, opts: { apply: false, targetHost: null } }), /Set DATABASE_URL/);
  assert.equal(
    checkTarget({ databaseUrl: 'postgresql://u:p@db.example.com:5432/app', opts: { apply: false, targetHost: null } }),
    'db.example.com',
  );
  assert.throws(
    () => checkTarget({ databaseUrl: 'postgresql://u:p@db.example.com:5432/app', opts: { apply: true, targetHost: null } }),
    /--apply needs --target-host=db.example.com/,
  );
  assert.throws(
    () => checkTarget({ databaseUrl: 'postgresql://u:p@db.example.com:5432/app', opts: { apply: true, targetHost: 'other.example.com' } }),
    /--apply needs --target-host=db.example.com/,
  );
  assert.equal(
    checkTarget({ databaseUrl: 'postgresql://u:p@db.example.com:5432/app', opts: { apply: true, targetHost: 'db.example.com' } }),
    'db.example.com',
  );
});

// ---- Helpers ----

function itemMatches(it, where) {
  if (!where) return true;
  if (where.userId !== undefined && it.userId !== where.userId) return false;
  if (where.origin !== undefined && it.origin !== where.origin) return false;
  if (where.layerKey !== undefined && it.layerKey !== where.layerKey) return false;
  if (where.active !== undefined && it.active !== where.active) return false;
  if (where.kind !== undefined && it.kind !== where.kind) return false;
  if (Array.isArray(where.OR)) return where.OR.some((w) => itemMatches(it, { ...where, OR: undefined, ...w }));
  return true;
}

function completionMatches(c, where) {
  if (!where) return true;
  if (where.userId !== undefined && c.userId !== where.userId) return false;
  if (where.how !== undefined && c.how !== where.how) return false;
  return true;
}

function fakePrisma(state = {}) {
  const writes = [];
  const s = {
    coachConsent: state.coachConsent ?? [],
    journeyProgress: state.journeyProgress ?? [],
    planItems: state.planItems ?? [],
    completions: state.completions ?? [],
  };
  return {
    writes,
    state: s,
    coachConsent: {
      findMany: async ({ where } = {}) =>
        s.coachConsent
          .filter((c) => {
            if (where?.revokedAt === null && c.revokedAt != null) return false;
            const has = where?.scopes?.has;
            if (has && !(c.scopes ?? []).includes(has)) return false;
            return true;
          })
          .map((c) => ({ userId: c.userId })),
    },
    journeyProgress: {
      findMany: async () => s.journeyProgress.map((j) => ({ userId: j.userId })),
    },
    planItem: {
      count: async ({ where } = {}) => s.planItems.filter((it) => itemMatches(it, where)).length,
      updateMany: async ({ where, data } = {}) => {
        const matched = s.planItems.filter((it) => itemMatches(it, where));
        for (const it of matched) Object.assign(it, data);
        writes.push({ model: 'planItem', op: 'updateMany', where, data, count: matched.length });
        return { count: matched.length };
      },
    },
    planItemCompletion: {
      count: async ({ where } = {}) => s.completions.filter((c) => completionMatches(c, where)).length,
      deleteMany: async ({ where } = {}) => {
        const matched = s.completions.filter((c) => completionMatches(c, where));
        s.completions = s.completions.filter((c) => !completionMatches(c, where));
        writes.push({ model: 'planItemCompletion', op: 'deleteMany', where, count: matched.length });
        return { count: matched.length };
      },
    },
  };
}

const consent = (userId, extra = {}) => ({
  userId,
  scopes: ['basic'],
  revokedAt: null,
  ...extra,
});

// A pre-journey user: a user-created habit, a doctor row, two suggested rows
// (one nutrition, one workout), and a mix of manual/auto completions.
function preJourneyState(userId) {
  return {
    coachConsent: [consent(userId)],
    journeyProgress: [{ userId }],
    planItems: [
      { id: 1, userId, origin: 'user', kind: 'habit', layerKey: null, active: true },
      { id: 2, userId, origin: 'doctor', kind: 'doctor_medication', layerKey: null, active: true },
      { id: 3, userId, origin: 'suggested', kind: 'nutrition', layerKey: null, active: true },
      { id: 4, userId, origin: 'suggested', kind: 'workout', layerKey: null, active: true },
      { id: 5, userId, origin: 'suggested', kind: 'habit', layerKey: 'water', active: true },
    ],
    completions: [
      { id: 11, userId, planItemId: 1, how: 'manual' },
      { id: 12, userId, planItemId: 3, how: 'auto' },
      { id: 13, userId, planItemId: 4, how: 'auto' },
    ],
  };
}

// ---- migrateToOnePlan ----

test('dry run counts the migration without writing', async () => {
  const prisma = fakePrisma(preJourneyState(1));
  const rebuildCalls = [];

  const r = await migrateToOnePlan(prisma, {
    apply: false,
    rebuild: async (...args) => { rebuildCalls.push(args); return {}; },
  });

  assert.equal(r.scanned, 1);
  assert.equal(r.users.length, 1);
  const u = r.users[0];
  assert.equal(u.ownAssigned, 1); // id 1
  assert.equal(u.medicineAssigned, 1); // id 2
  assert.equal(u.deactivated, 2); // ids 3 (nutrition) + 4 (workout, null layerKey)
  assert.equal(u.autoDeleted, 2); // ids 12, 13
  assert.equal(u.rebuilt, false);
  assert.equal(r.errors.length, 0);

  assert.equal(prisma.writes.length, 0, 'dry run writes nothing');
  assert.equal(rebuildCalls.length, 0, 'dry run does not rebuild');
  // Suggested rows already on a layer (id 5) are left alone.
  assert.equal(prisma.state.planItems.find((it) => it.id === 5).active, true);
  assert.equal(prisma.state.planItems.find((it) => it.id === 5).layerKey, 'water');
});

test('apply sets layer keys, deactivates suggested rows, deletes auto completions and rebuilds', async () => {
  const prisma = fakePrisma(preJourneyState(1));
  const rebuildCalls = [];

  const r = await migrateToOnePlan(prisma, {
    apply: true,
    rebuild: async (p, userId, opts) => {
      rebuildCalls.push({ userId, opts });
      return { created: 0, updated: 0, deactivated: 0, onLayerKeys: ['own', 'medicine'] };
    },
  });

  assert.equal(r.scanned, 1);
  const u = r.users[0];
  assert.equal(u.ownAssigned, 1);
  assert.equal(u.medicineAssigned, 1);
  assert.equal(u.deactivated, 2);
  assert.equal(u.autoDeleted, 2);
  assert.equal(u.rebuilt, true);
  assert.equal(r.errors.length, 0);

  assert.equal(prisma.state.planItems.find((it) => it.id === 1).layerKey, 'own');
  assert.equal(prisma.state.planItems.find((it) => it.id === 2).layerKey, 'medicine');
  assert.equal(prisma.state.planItems.find((it) => it.id === 3).active, false);
  assert.equal(prisma.state.planItems.find((it) => it.id === 4).active, false);
  assert.deepEqual(prisma.state.completions.map((c) => c.how), ['manual']);

  assert.equal(rebuildCalls.length, 1);
  assert.equal(rebuildCalls[0].userId, 1);
  assert.deepEqual(rebuildCalls[0].opts, { reason: 'migrate' });
});

test('apply is idempotent: a second run finds nothing left to change', async () => {
  const prisma = fakePrisma(preJourneyState(1));
  const rebuild = async () => ({ created: 0, updated: 0, deactivated: 0, onLayerKeys: [] });

  const first = await migrateToOnePlan(prisma, { apply: true, rebuild });
  assert.equal(first.users[0].ownAssigned, 1);

  const second = await migrateToOnePlan(prisma, { apply: true, rebuild });
  assert.equal(second.scanned, 1);
  const u = second.users[0];
  assert.equal(u.ownAssigned, 0);
  assert.equal(u.medicineAssigned, 0);
  assert.equal(u.deactivated, 0);
  assert.equal(u.autoDeleted, 0);
  assert.equal(u.rebuilt, true, 'rebuild still runs — it regenerates the suggested rows');
  assert.equal(second.errors.length, 0);
});

test('users without coach consent are reported but left alone', async () => {
  const prisma = fakePrisma({
    coachConsent: [consent(1)],
    journeyProgress: [{ userId: 1 }, { userId: 2 }],
    planItems: [
      { id: 1, userId: 1, origin: 'user', kind: 'habit', layerKey: null, active: true },
      { id: 2, userId: 2, origin: 'user', kind: 'habit', layerKey: null, active: true },
    ],
    completions: [],
  });

  const r = await migrateToOnePlan(prisma, { apply: true, rebuild: async () => ({}) });

  assert.equal(r.scanned, 1);
  assert.equal(r.withoutConsent, 1);
  assert.equal(r.users.length, 1);
  assert.equal(r.users[0].userId, 1);
  // User 2 was never touched.
  assert.equal(prisma.state.planItems.find((it) => it.id === 2).layerKey, null);
  assert.ok(prisma.writes.every((w) => w.where?.userId === 1 || w.where?.userId === undefined));
});

test('revoked or supplements-only consent is not a candidate', async () => {
  const prisma = fakePrisma({
    coachConsent: [
      consent(1, { revokedAt: new Date('2026-10-01') }),
      consent(2, { scopes: ['supplements'] }),
    ],
    journeyProgress: [{ userId: 1 }, { userId: 2 }],
    planItems: [],
    completions: [],
  });

  const r = await migrateToOnePlan(prisma, { apply: true, rebuild: async () => ({}) });

  assert.equal(r.scanned, 0);
  assert.equal(r.users.length, 0);
  assert.equal(r.withoutConsent, 2);
});

test('consent without a JourneyProgress is counted but not migrated', async () => {
  const prisma = fakePrisma({
    coachConsent: [consent(1)],
    journeyProgress: [],
    planItems: [{ id: 1, userId: 1, origin: 'user', kind: 'habit', layerKey: null, active: true }],
    completions: [],
  });

  const r = await migrateToOnePlan(prisma, { apply: true, rebuild: async () => ({}) });

  assert.equal(r.scanned, 0);
  assert.equal(r.consentNoJourney, 1);
  assert.equal(prisma.writes.length, 0);
});

test('a rebuildPlan failure on one user does not stop the others', async () => {
  const prisma = fakePrisma({
    coachConsent: [consent(1), consent(2)],
    journeyProgress: [{ userId: 1 }, { userId: 2 }],
    planItems: [
      { id: 1, userId: 1, origin: 'user', kind: 'habit', layerKey: null, active: true },
      { id: 2, userId: 2, origin: 'user', kind: 'habit', layerKey: null, active: true },
    ],
    completions: [],
  });

  const r = await migrateToOnePlan(prisma, {
    apply: true,
    rebuild: async (p, userId) => {
      if (userId === 1) throw Object.assign(new Error('not implemented'), { status: 501 });
      return { created: 0, updated: 0, deactivated: 0, onLayerKeys: [] };
    },
  });

  assert.equal(r.scanned, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].userId, 1);
  assert.match(r.errors[0].error, /rebuildPlan: not implemented/);
  // User 1's data migration still happened; user 2 was rebuilt.
  assert.equal(prisma.state.planItems.find((it) => it.id === 1).layerKey, 'own');
  assert.equal(r.users.find((u) => u.userId === 2).rebuilt, true);
});

test('only active suggested rows are deactivated — an already-deactivated one is skipped', async () => {
  const prisma = fakePrisma({
    coachConsent: [consent(1)],
    journeyProgress: [{ userId: 1 }],
    planItems: [
      { id: 1, userId: 1, origin: 'suggested', kind: 'nutrition', layerKey: null, active: false },
      { id: 2, userId: 1, origin: 'suggested', kind: 'nutrition', layerKey: null, active: true },
    ],
    completions: [],
  });

  const r = await migrateToOnePlan(prisma, { apply: true, rebuild: async () => ({}) });

  assert.equal(r.users[0].deactivated, 1);
  const writes = prisma.writes.filter((w) => w.op === 'updateMany' && w.where?.origin === 'suggested');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].count, 1);
});
