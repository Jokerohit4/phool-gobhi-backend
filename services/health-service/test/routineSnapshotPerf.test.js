// Item 4: GET /habits/today -> routineSnapshot. Independent reads run together and
// the heavy "recent sessions with sets" repair read is gated by a per-user 5-min
// cache that a workout finish evicts. Cache forced ON for this file.
// Run with: node --experimental-test-module-mocks --test
process.env.HEALTH_CACHE_FORCE = '1';

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let flag = true;
mock.module('../middleware/requireFeatureFlag.js', { namedExports: { isFeatureEnabled: async () => flag } });
mock.module('../utils/fetchInternal.js', { namedExports: { fetchInternal: async () => ({ data: {} }) } });
const { routineSnapshot } = await import('../services/routineJourneyService.js');
const { emitJourneyInvalidate } = await import('../utils/journeyCacheBus.js');

const created = new Date('2026-10-26T05:00:00Z');
function fake({ sessions = [], water = null, claims = 0 } = {}) {
  const state = { userId: 7, accountCreatedAt: created, waterLoggedAt: null, workoutCompletedAt: null };
  const p = {
    state, reads: { sessions: 0, water: 0, claims: 0 }, inflight: 0, maxInflight: 0, sessions,
    routineJourneyState: {
      findUnique: async () => state,
      update: async ({ data }) => Object.assign(state, data),
    },
    waterLog: { findFirst: async () => { p.reads.water++; return water; } },
    routineRewardClaim: { count: async () => { p.reads.claims++; return claims; } },
    workoutSession: {
      findMany: async (args) => {
        p.reads.sessions++; p.lastArgs = args;
        p.inflight++; p.maxInflight = Math.max(p.maxInflight, p.inflight);
        await new Promise((r) => setTimeout(r, 10));
        p.inflight--;
        return p.sessions;
      },
    },
  };
  return p;
}
const done = (completed) => ({ type: 'strength', endedAt: new Date(), startedAt: new Date(Date.now() - 3600_000), exercises: [{ sets: [{ completed }] }] });

test('heavy session read is cached per user; second GET does not repeat it', async () => {
  emitJourneyInvalidate(7);
  const p = fake();
  const a = await routineSnapshot(p, 7);
  const b = await routineSnapshot(p, 7);
  assert.equal(p.reads.sessions, 1, 'was one 100-session read per GET');
  assert.deepEqual(a, b);
  assert.equal(a.workoutCompleted, false);
  assert.deepEqual(Object.keys(p.lastArgs.select).sort(), ['endedAt', 'exercises', 'startedAt', 'type'], 'narrow select');
  assert.equal(p.lastArgs.take, 100);
});

test('workout finish (journey invalidate) evicts, so a qualifying session heals the flag immediately', async () => {
  emitJourneyInvalidate(7);
  const p = fake();
  assert.equal((await routineSnapshot(p, 7)).workoutCompleted, false);
  p.sessions = [done(true)];
  assert.equal((await routineSnapshot(p, 7)).workoutCompleted, false, 'still within cache window, no event yet');
  emitJourneyInvalidate(7);
  const after = await routineSnapshot(p, 7);
  assert.equal(after.workoutCompleted, true);
  assert.ok(p.state.workoutCompletedAt);
  const reads = p.reads.sessions;
  await routineSnapshot(p, 7);
  assert.equal(p.reads.sessions, reads, 'flag set -> heavy read skipped entirely');
});

test('an unfinished (no completed set) session does not qualify; eviction is per user', async () => {
  emitJourneyInvalidate(7); emitJourneyInvalidate(8);
  const p = fake({ sessions: [done(false)] });
  assert.equal((await routineSnapshot(p, 7)).workoutCompleted, false);
  const n = p.reads.sessions;
  emitJourneyInvalidate(8);
  await routineSnapshot(p, 7);
  assert.equal(p.reads.sessions, n, "user 8's eviction leaves user 7 cached");
});

test('water/claims/flag reads run in parallel with the session read and output is unchanged', async () => {
  emitJourneyInvalidate(7);
  const p = fake({ water: { createdAt: new Date('2026-10-26T07:00:00Z') }, claims: 2 });
  const out = await routineSnapshot(p, 7);
  assert.equal(out.waterLogged, true);
  assert.equal(out.rewardsEnabled, true);
  assert.equal(out.rewardsPending, true);
  assert.equal(p.reads.water, 1); assert.equal(p.reads.claims, 1);
  assert.equal(out.policy.eligible !== undefined, true);
});
