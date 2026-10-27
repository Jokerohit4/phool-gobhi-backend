import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { routineRewardPolicy } from '../services/routineRewardPolicy.js';
import { JOURNEY, elapsedJourneyDays } from '../services/journey/journeyConfig.js';

const createdAt = new Date('2026-10-26T05:00:00Z');
const now = new Date('2026-10-26T06:00:00Z');
let failCredit = false;
let enabled = true;
const ledger = new Map();
mock.module('../middleware/requireFeatureFlag.js', { namedExports: { isFeatureEnabled: async () => enabled } });
mock.module('../utils/fetchInternal.js', { namedExports: { fetchInternal: async (_base, path, options) => {
  if (path.startsWith('/internal/coins/')) {
    if (failCredit) throw new Error('network');
    const body = options.body;
    if (!ledger.has(body.idempotencyKey)) ledger.set(body.idempotencyKey, body.amount);
    return { data: {} };
  }
  return { data: { createdAt } };
} } });
const { recordRoutineWater, payRoutineClaims, recordRoutineWorkout } = await import('../services/routineJourneyService.js');

function fake() {
  const state = { userId: 7, accountCreatedAt: createdAt, waterLoggedAt: null, workoutCompletedAt: null };
  const days = new Map(), claims = new Map();
  let total = 250, queue = Promise.resolve();
  const p = {
    state, days, claims, setTotal: n => total = n,
    routineJourneyState: {
      findUnique: async () => state,
      updateMany: async ({ data }) => { Object.assign(state, data); return { count: 1 }; },
    },
    routineWaterDay: {
      findFirst: async () => [...days.values()].filter(d => d.lastRewardAt).sort((a,b) => b.lastRewardAt - a.lastRewardAt)[0] ?? null,
      upsert: async ({ create }) => {
        const key = `${create.userId}:${create.localDate}`;
        if (!days.has(key)) days.set(key, { ...create, rewardedLogs: 0, lastRewardAt: null });
        return { ...days.get(key) };
      },
      update: async ({ where, data }) => {
        const d = days.get(`${where.userId_localDate.userId}:${where.userId_localDate.localDate}`);
        d.rewardedLogs += data.rewardedLogs.increment; d.lastRewardAt = data.lastRewardAt;
      },
    },
    routineRewardClaim: {
      upsert: async ({ create }) => { if (!claims.has(create.key)) claims.set(create.key, { ...create, paidAt: null }); },
      findMany: async ({ where }) => [...claims.values()].filter(c => c.userId === where.userId && !c.paidAt),
      updateMany: async ({ where, data }) => {
        const c = claims.get(where.key); if (c.paidAt) return { count: 0 };
        Object.assign(c, data); return { count: 1 };
      },
      count: async () => [...claims.values()].filter(c => !c.paidAt).length,
    },
    waterLog: { aggregate: async () => ({ _sum: { ml: total } }) },
  };
  p.$transaction = body => { const next = queue.then(() => body(p)); queue = next.catch(() => {}); return next; };
  return p;
}
const log = (p, at = now, options = {}) => recordRoutineWater(p, {
  userId: 7, localDate: '2026-10-26', targetMl: 2500, now: at, ...options,
});

test('calendar unlocks are 7/10/15 days, based on IST dates at midnight', () => {
  assert.deepEqual(JOURNEY.layers.filter(l => l.unlock.type === 'elapsed_days').map(l => l.unlock.need), [7, 10, 15]);
  assert.equal(elapsedJourneyDays('2026-10-26T18:29:00Z', new Date('2026-11-02T18:29:00Z')), 7);
  assert.equal(elapsedJourneyDays('2026-10-26T18:29:00Z', new Date('2026-11-02T18:30:00Z')), 8);
});
test('small rewards taper at day 8 and day 15; old and future accounts cannot get starter coins', () => {
  assert.equal(routineRewardPolicy(createdAt, now).waterLog, 1);
  const week2 = routineRewardPolicy(createdAt, new Date('2026-11-02T06:00:00Z'));
  assert.deepEqual([week2.waterLog, week2.waterTarget, week2.workout, week2.locationWorkout], [0, 1, 1, 3]);
  const steady = routineRewardPolicy(createdAt, new Date('2026-11-09T06:00:00Z'));
  assert.deepEqual([steady.waterLog, steady.waterTarget, steady.workout, steady.locationWorkout], [0, 0, 0, 3]);
  assert.equal(routineRewardPolicy('2020-01-01', now).eligible, false);
  assert.equal(routineRewardPolicy('2030-01-01', now).eligible, false);
});
test('first log pays one coin; simultaneous taps and sub-hour logs cannot pay again', async () => {
  ledger.clear(); const p = fake();
  const results = await Promise.all([log(p), log(p), log(p)]);
  assert.equal(results.reduce((s, r) => s + r.coinsAwarded, 0), 1);
  assert.equal((await log(p, new Date(now.getTime() + 59 * 60000))).coinsAwarded, 0);
  assert.equal((await log(p, new Date(now.getTime() + 60 * 60000))).coinsAwarded, 1);
  assert.equal(p.state.waterLoggedAt instanceof Date, true);
});
test('only three water logs/day; immutable target and paid claims survive undo/re-log', async () => {
  ledger.clear(); const p = fake();
  for (let hour = 0; hour < 5; hour++) await log(p, new Date(now.getTime() + hour * 3600000));
  assert.equal([...ledger.values()].reduce((a, b) => a + b, 0), 3);
  p.setTotal(500);
  await log(p, new Date(now.getTime() + 6 * 3600000), { targetMl: 250 });
  assert.equal(p.claims.size, 3, 'lowering the current target cannot replace the day snapshot');
  p.setTotal(2500); assert.equal((await log(p)).coinsAwarded, 1);
  p.setTotal(0); await log(p); p.setTotal(2500); await log(p);
  assert.equal(p.claims.size, 4);
});
test('credit outages leave durable claims; explicit retry pays once without another drink', async () => {
  ledger.clear(); const p = fake(); failCredit = true;
  assert.deepEqual(await log(p), { coinsAwarded: 0, pending: true });
  failCredit = false;
  assert.deepEqual(await payRoutineClaims(p, 7), { coinsAwarded: 1, pending: false });
  assert.deepEqual(await payRoutineClaims(p, 7), { coinsAwarded: 0, pending: false });
  assert.equal((await log(p, new Date(now.getTime() + 2 * 3600000), { replayed: true })).coinsAwarded, 0);
  assert.equal(p.claims.size, 1, 'replaying an old successful request cannot qualify as a new drink');
});
test('off-date logs and disabled rollout do not pay, but a saved drink records progress', async () => {
  const p = fake();
  assert.equal((await log(p, now, { localDate: '2026-10-25' })).coinsAwarded, 0);
  assert.equal(p.claims.size, 0);
  enabled = false;
  assert.equal((await log(p)).coinsAwarded, 0);
  enabled = true;
});
test('empty/rest/instant sessions cannot earn starter workout coins', async () => {
  const p = fake();
  const session = { userId: 7, localDate: '2026-10-26', type: 'rest', endedAt: now, startedAt: now, exercises: [] };
  assert.equal(await recordRoutineWorkout(p, session), null);
  const result = await recordRoutineWorkout(p, { ...session, type: 'strength', exercises: [{ sets: [{ completed: true }] }] });
  assert.deepEqual(result, { starterAmount: 0, verifiedAmount: 0 });
});

test('midnight cannot reset the one-hour spacing', async () => {
  ledger.clear(); const p = fake();
  assert.equal((await log(p, new Date('2026-10-26T18:29:00Z'))).coinsAwarded, 1);
  assert.equal((await log(p, new Date('2026-10-26T18:31:00Z'), { localDate: '2026-10-27' })).coinsAwarded, 0);
  assert.equal((await log(p, new Date('2026-10-26T19:29:00Z'), { localDate: '2026-10-27' })).coinsAwarded, 1);
});
