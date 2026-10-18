import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareOnePlanDev } from '../scripts/prepareOnePlanDev.js';

function scenario(change = {}) {
  const state = {
    items: [
      { id: 1, userId: 7, origin: 'user', layerKey: null, title: 'Read', active: true },
      { id: 2, userId: 7, origin: 'doctor', layerKey: null, title: 'Prescribed', active: true },
      { id: 3, userId: 7, origin: 'suggested', layerKey: 'water', active: true },
    ],
    ticks: [{ id: 4, userId: 7, planItemId: 1, how: 'manual' }],
    applies: 0,
  };
  const prisma = {
    planItem: { findMany: async ({ where }) => structuredClone(state.items.filter(i =>
      typeof where.origin === 'string' ? i.origin === where.origin : where.origin.in.includes(i.origin))) },
    planItemCompletion: { findMany: async () => structuredClone(state.ticks) },
  };
  const migrate = async (_prisma, { apply }) => {
    if (apply) {
      state.applies++;
      state.items[0].layerKey = 'own';
      state.items[1].layerKey = 'medicine';
      change.onApply?.(state);
    }
    return {
      scanned: 1,
      errors: apply ? (change.applyErrors ?? []) : (change.dryErrors ?? []),
      users: [{ userId: apply && change.changedPopulation ? 8 : 7,
        rebuilt: apply && !change.missingRebuild,
        ownAssigned: !apply && state.applies === 0 ? 1 : (change.pending ? 1 : 0),
        medicineAssigned: !apply && state.applies === 0 ? 1 : 0,
        deactivated: 0, autoDeleted: 0 }],
    };
  };
  const rebuild = async () => {
    change.onRebuild?.(state);
    return { created: 0, updated: 0, deactivated: 0, ...change.rebuildResult };
  };
  return { state, prisma, migrate, rebuild };
}

test('dev migration dry run returns counts without applying', async () => {
  const s = scenario();
  const result = await prepareOnePlanDev(s.prisma, s);
  assert.equal(result.mode, 'dry-run');
  assert.equal(s.state.applies, 0);
  assert.equal(s.state.items[0].layerKey, null);
});

test('dev apply verifies all rebuilds, preserves own/doctor identities and ticks, and checks idempotency', async () => {
  const s = scenario();
  const result = await prepareOnePlanDev(s.prisma, { ...s, apply: true });
  assert.equal(result.verified, true);
  assert.equal(result.rebuiltUsers, 1);
  assert.equal(s.state.applies, 1);
  assert.deepEqual(s.state.items.map(i => i.id), [1, 2, 3]);
  assert.equal(s.state.ticks[0].id, 4);
});

for (const [name, change] of [
  ['dry-run errors', { dryErrors: [{ userId: 7, error: 'failed' }] }],
  ['apply errors', { applyErrors: [{ userId: 7, error: 'failed' }] }],
  ['missing rebuild', { missingRebuild: true }],
  ['population changed', { changedPopulation: true }],
  ['manual tick removed', { onApply: s => s.ticks.pop() }],
  ['doctor item altered', { onApply: s => { s.items[1].title = 'Changed'; } }],
  ['pending migration changes', { pending: true }],
  ['rebuild created rows', { rebuildResult: { created: 1 } }],
  ['rebuild updated rows', { rebuildResult: { updated: 1 } }],
  ['rebuild deactivated rows', { rebuildResult: { deactivated: 1 } }],
  ['rebuild changed identities', { onRebuild: s => { s.items[2].id = 99; } }],
  ['rebuild changed manual ticks', { onRebuild: s => s.ticks.pop() }],
]) {
  test(`dev migration refuses acceptance when ${name}`, async () => {
    const s = scenario(change);
    await assert.rejects(() => prepareOnePlanDev(s.prisma, { ...s, apply: true }));
    if (change.dryErrors) assert.equal(s.state.applies, 0);
  });
}
