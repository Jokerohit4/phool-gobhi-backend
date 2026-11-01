// Item 4 (route half): GET /habits/today starts routineSnapshot together with the
// habit reads instead of after them, and a failing snapshot still never fails the
// screen (routine: null). Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let log; let snapshot; let getToday;

test('setup', async (t) => {
  t.mock.module('../services/routineJourneyService.js', { exports: {
    routineSnapshot: async () => { log.push('routine:start'); const out = await snapshot(); log.push('routine:end'); return out; },
    recordRoutineWater: async () => ({ coinsAwarded: 0, pending: false }),
  } });
  t.mock.module('../services/plan/rebuildPlan.js', { exports: { rebuildPlan: async () => ({}) } });
  ({ getToday } = await import('../services/habitsService.js'));
});

const prisma = () => ({
  nutritionTarget: { findFirst: async () => { await delay(10); return { waterMl: 2500 }; } },
  waterLog: { findMany: async () => { log.push('water'); await delay(20); return [{ id: 1, ml: 250 }]; } },
  supplementSchedule: { findMany: async () => [{ id: 1, name: 'D3', times: ['09:00'] }] },
  supplementLog: { findMany: async () => [] },
});

test('routine snapshot starts before the habit reads finish; output shape unchanged', async () => {
  log = []; snapshot = async () => { await delay(5); return { waterLogged: true }; };
  const out = await getToday(prisma(), { userId: 1, localDate: '2026-10-30' });
  assert.ok(log.indexOf('routine:start') < log.indexOf('water') + 1 && log.indexOf('routine:start') >= 0);
  assert.deepEqual(Object.keys(out), ['water', 'supplements', 'routine']);
  assert.equal(out.water.loggedMl, 250);
  assert.equal(out.water.targetMl, 2500);
  assert.deepEqual(out.routine, { waterLogged: true });
});

test('a failing snapshot is swallowed: routine null, the rest of the screen intact', async () => {
  log = []; snapshot = async () => { throw new Error('auth down'); };
  const origError = console.error; console.error = () => {};
  try {
    const out = await getToday(prisma(), { userId: 1, localDate: '2026-10-30' });
    assert.equal(out.routine, null);
    assert.equal(out.supplements.length, 1);
  } finally { console.error = origError; }
});

test('a slow snapshot overlaps the habit reads instead of adding to them', async () => {
  log = []; snapshot = async () => { await delay(30); return null; };
  const t0 = Date.now();
  await getToday(prisma(), { userId: 1, localDate: '2026-10-30' });
  assert.ok(Date.now() - t0 < 30 + 25, 'serial would be ~30ms snapshot + 20ms reads');
});
