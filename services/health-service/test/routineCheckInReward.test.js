import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { routineRewardPolicy } from '../services/routineRewardPolicy.js';

const createdAt = new Date('2026-10-26T05:00:00Z');
const day1 = new Date('2026-10-26T06:00:00Z');
let failCredit = false;
let enabled = true;
let stateCreatedAt = createdAt;
let stateThrows = false;
const ledger = new Map();
mock.module('../middleware/requireFeatureFlag.js', { namedExports: { isFeatureEnabled: async () => enabled } });
mock.module('../utils/fetchInternal.js', { namedExports: { fetchInternal: async (_base, path, options) => {
  if (path.startsWith('/internal/coins/')) {
    if (failCredit) throw new Error('network');
    const body = options.body;
    if (!ledger.has(body.idempotencyKey)) ledger.set(body.idempotencyKey, body.amount);
    return { data: {} };
  }
  return { data: { createdAt: stateCreatedAt } };
} } });
const { recordRoutineCheckIn, payRoutineClaims } = await import('../services/routineJourneyService.js');

function fake() {
  const claims = new Map();
  return {
    claims,
    routineJourneyState: {
      findUnique: async () => {
        if (stateThrows) throw new Error('db down');
        return { userId: 7, accountCreatedAt: stateCreatedAt };
      },
    },
    routineRewardClaim: {
      upsert: async ({ create }) => { if (!claims.has(create.key)) claims.set(create.key, { ...create, paidAt: null }); },
      findMany: async ({ where }) => [...claims.values()].filter((c) => c.userId === where.userId && !c.paidAt),
      updateMany: async ({ where, data }) => {
        const c = claims.get(where.key);
        if (c.paidAt) return { count: 0 };
        Object.assign(c, data);
        return { count: 1 };
      },
      count: async () => [...claims.values()].filter((c) => !c.paidAt).length,
    },
  };
}

const reset = () => { failCredit = false; enabled = true; stateCreatedAt = createdAt; stateThrows = false; ledger.clear(); };
const checkIn = (p, kind, localDate = '2026-10-26', now = day1) =>
  recordRoutineCheckIn(p, { userId: 7, kind, localDate, now });

test('policy: sleep and mood coins only for eligible accounts in their first two weeks', () => {
  const young = routineRewardPolicy(createdAt, day1);
  assert.equal(young.sleepLog, 1);
  assert.equal(young.moodLog, 1);
  const old = routineRewardPolicy(createdAt, new Date('2026-11-10T06:00:00Z'));
  assert.equal(old.sleepLog, 0);
  assert.equal(old.moodLog, 0);
  const beforeLaunch = routineRewardPolicy(new Date('2026-10-01T00:00:00Z'), day1);
  assert.equal(beforeLaunch.sleepLog, 0);
  assert.equal(beforeLaunch.moodLog, 0);
});

test('a saved sleep/body number pays one coin, once per day', async () => {
  reset();
  const p = fake();
  assert.deepEqual(await checkIn(p, 'sleep'), { coinsAwarded: 1, pending: false });
  assert.deepEqual(await checkIn(p, 'sleep'), { coinsAwarded: 0, pending: false });
  assert.equal(ledger.size, 1);
});

test('a mood check-in pays one coin a day, whichever slot, and morning + night never double up', async () => {
  reset();
  const p = fake();
  assert.equal((await checkIn(p, 'mood')).coinsAwarded, 1);
  assert.equal((await checkIn(p, 'mood')).coinsAwarded, 0);
  assert.equal(ledger.size, 1);
});

test('sleep and mood are separate coins on the same day', async () => {
  reset();
  const p = fake();
  assert.equal((await checkIn(p, 'sleep')).coinsAwarded, 1);
  assert.equal((await checkIn(p, 'mood')).coinsAwarded, 1);
  assert.equal(ledger.size, 2);
});

test('the next day pays again', async () => {
  reset();
  const p = fake();
  await checkIn(p, 'sleep');
  const next = await checkIn(p, 'sleep', '2026-10-27', new Date('2026-10-27T06:00:00Z'));
  assert.equal(next.coinsAwarded, 1);
  assert.equal(ledger.size, 2);
});

test('nothing is paid past the first two weeks, before launch, or with coins off', async () => {
  reset();
  const late = await checkIn(fake(), 'sleep', '2026-11-10', new Date('2026-11-10T06:00:00Z'));
  assert.deepEqual(late, { coinsAwarded: 0, pending: false });

  reset();
  stateCreatedAt = new Date('2026-10-01T00:00:00Z');
  assert.equal((await checkIn(fake(), 'mood')).coinsAwarded, 0);

  reset();
  enabled = false;
  const p = fake();
  assert.equal((await checkIn(p, 'sleep')).coinsAwarded, 0);
  assert.equal(p.claims.size, 0);
});

test('a slow coin service leaves the claim pending and the retry pays it once', async () => {
  reset();
  const p = fake();
  failCredit = true;
  assert.deepEqual(await checkIn(p, 'sleep'), { coinsAwarded: 0, pending: true });
  failCredit = false;
  assert.deepEqual(await payRoutineClaims(p, 7), { coinsAwarded: 1, pending: false });
  assert.deepEqual(await payRoutineClaims(p, 7), { coinsAwarded: 0, pending: false });
  assert.equal(ledger.size, 1);
});

test('a failing lookup or an unknown kind never throws into the save', async () => {
  reset();
  stateThrows = true;
  assert.deepEqual(await checkIn(fake(), 'sleep'), { coinsAwarded: 0, pending: false });
  reset();
  assert.deepEqual(await checkIn(fake(), 'steps'), { coinsAwarded: 0, pending: false });
  assert.deepEqual(await checkIn(fake(), 'mood', null), { coinsAwarded: 0, pending: false });
});
