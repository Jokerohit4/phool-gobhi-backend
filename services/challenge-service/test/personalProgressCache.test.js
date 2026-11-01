import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CHALLENGE_CACHE_FORCE = '1'; // ttlCache is off under node --test otherwise

let count = 0, fail = false, current, fetches, gate = null, upserts = [];
const ledger = new Map(); // idempotencyKey -> amount (one entry per key, like coinLedgerService)
let creditCalls = [];
const prisma = {
  challengeEnrollment: {
    updateMany: async ({ data }) => { if (current.status === 'active') current = { ...current, ...data }; return { count: 1 }; },
    findUnique: async () => current,
    create: async ({ data }) => ({ id: 77, status: 'active', progressCount: 0, startedAt: new Date('2026-10-30T00:00:00Z'), ...data }),
    update: async ({ data }) => ({ ...current, ...data }),
  },
  challenge: { findUnique: async () => ({ id: 10, status: 'active', targetCount: 3, challengeDefinition: { audiences: ['wellness'], category: 'personal_habit', defaultVerificationMethod: 'activity_log' } }) },
  rewardIssuance: { upsert: async ({ where }) => { upserts.push(where.enrollmentId); return {}; } },
};
let refreshPersonalChallenge, enrollService, leaveChallengeService, evictPersonalProgress, clearPersonalProgressCache, progressKey;

test('setup', async t => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class { constructor() { return prisma; } } } });
  t.mock.module(new URL('../services/coinLedgerService.js', import.meta.url).href, { exports: {
    creditCoinsService: async (userId, amount, description, key) => { creditCalls.push(key); if (!ledger.has(key)) ledger.set(key, amount); },
  } });
  t.mock.module(new URL('../middleware/requireFeatureFlag.js', import.meta.url).href, { exports: { isFeatureEnabled: async () => true } });
  t.mock.module(new URL('../utils/analytics.js', import.meta.url).href, { exports: { track: () => {} } });
  ({ refreshPersonalChallenge } = await import('../services/personalChallengeService.js'));
  ({ enrollService, leaveChallengeService } = await import('../services/challengeEnrollmentService.js'));
  ({ evictPersonalProgress, clearPersonalProgressCache, progressKey } = await import('../utils/personalProgressCache.js'));
});

beforeEach(() => {
  clearPersonalProgressCache?.();
  count = 0; fail = false; fetches = 0; gate = null; upserts = []; ledger.clear(); creditCalls = [];
  current = { id: 3, userId: 42, status: 'active', progressCount: 0, startedAt: new Date('2026-10-20T00:00:00Z') };
});
const quest = () => ({ id: 10, targetCount: 3, rewardCoins: 5, enrollments: [current],
  challengeDefinition: { type: 'water_consistency', defaultVerificationMethod: 'activity_log', audiences: ['wellness'] } });
async function withActivity(action) {
  const previous = global.fetch;
  global.fetch = async () => {
    fetches++;
    if (gate) await gate;
    if (fail) throw new Error('unavailable');
    return { ok: true, json: async () => ({ data: { count } }) };
  };
  try { await action(); } finally { global.fetch = previous; }
}

test('list calls within the TTL share one health-service fetch', () => withActivity(async () => {
  count = 1;
  const a = await refreshPersonalChallenge(quest(), 42, 'wellness');
  const b = await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(fetches, 1);
  assert.equal(a.enrollments[0].progressCount, 1);
  assert.equal(b.enrollments[0].progressCount, 1);
}));

test('cache can only delay completion, never advance it early', () => withActivity(async () => {
  count = 2;
  await refreshPersonalChallenge(quest(), 42, 'wellness'); // caches 2
  count = 3; // third day logged in health-service
  const stale = await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(stale.enrollments[0].status, 'active', 'stale count: completion is later, not earlier');
  assert.equal(creditCalls.length, 0);
  clearPersonalProgressCache(); // = TTL expiry
  const fresh = await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(fresh.enrollments[0].status, 'completed');
  assert.equal(creditCalls.length, 1);
}));

test('a cached sub-target count never completes or pays', () => withActivity(async () => {
  count = 2;
  for (let i = 0; i < 4; i++) await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(creditCalls.length, 0);
  assert.equal(upserts.length, 0);
}));

test('completion path is idempotent: same count twice => one ledger entry, one issuance key', () => withActivity(async () => {
  count = 3;
  const first = await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(first.enrollments[0].status, 'completed');
  // Re-run the completion path for the SAME enrollment (a racing second list call).
  await refreshPersonalChallenge({ ...quest(), enrollments: [{ ...current, status: 'active', progressCount: 0 }] }, 42, 'wellness');
  assert.deepEqual([...ledger.keys()], ['challenge-reward:3']);
  assert.equal(ledger.size, 1, 'one coin issuance');
  assert.deepEqual(creditCalls, ['challenge-reward:3', 'challenge-reward:3']);
  assert.deepEqual(upserts, [3, 3], 'same enrollmentId upsert (unique row => one issuance)');
}));

test('failures are never cached: next call retries and then succeeds', () => withActivity(async () => {
  fail = true; count = 1;
  const down = await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(down.progressUnavailable, true);
  fail = false;
  const up = await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(up.progressUnavailable, undefined);
  assert.equal(up.enrollments[0].progressCount, 1);
  assert.equal(fetches, 2);
}));

test('single-flight: concurrent list calls share one fetch', () => withActivity(async () => {
  count = 1;
  let release; gate = new Promise(r => { release = r; });
  const ps = [1, 2, 3].map(() => refreshPersonalChallenge(quest(), 42, 'wellness'));
  await new Promise(r => setImmediate(r));
  release();
  await Promise.all(ps);
  assert.equal(fetches, 1);
}));

test('key includes enrollment id and start time: re-enrolment cannot read an old count', () => withActivity(async () => {
  count = 2;
  await refreshPersonalChallenge(quest(), 42, 'wellness'); // caches 2 for (42,3,start1)
  count = 0;
  const reenrolled = { ...current, id: 4, startedAt: new Date('2026-10-31T00:00:00Z'), progressCount: 0 };
  const sameIdNewStart = { ...current, startedAt: new Date('2026-10-31T00:00:00Z'), progressCount: 0 };
  assert.notEqual(progressKey(42, current), progressKey(42, reenrolled));
  assert.notEqual(progressKey(42, current), progressKey(42, sameIdNewStart));
  assert.notEqual(progressKey(42, current), progressKey(43, current));
  await refreshPersonalChallenge({ ...quest(), enrollments: [reenrolled] }, 42, 'wellness');
  await refreshPersonalChallenge({ ...quest(), enrollments: [sameIdNewStart] }, 42, 'wellness');
  assert.equal(fetches, 3, 'each distinct enrollment/start fetched its own count');
}));

test('joining evicts: a fresh enrollment re-reads even for the same key', () => withActivity(async () => {
  count = 2;
  await refreshPersonalChallenge(quest(), 42, 'wellness'); // cached 2
  count = 0;
  const prev = prisma.challengeEnrollment.findUnique;
  prisma.challengeEnrollment.findUnique = async () => null; // no existing row => create path
  try { await enrollService(42, 10, { audience: 'wellness' }); } finally { prisma.challengeEnrollment.findUnique = prev; } // evicts user's keys
  await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(fetches, 2);
}));

test('leaving evicts the user cache', () => withActivity(async () => {
  count = 2;
  await refreshPersonalChallenge(quest(), 42, 'wellness');
  await leaveChallengeService(42, 10);
  count = 0;
  await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(fetches, 2);
}));

test('eviction also detaches an in-flight read started before the join/leave', () => withActivity(async () => {
  count = 2;
  let release; gate = new Promise(r => { release = r; });
  const inflight = refreshPersonalChallenge(quest(), 42, 'wellness');
  await new Promise(r => setImmediate(r));
  evictPersonalProgress(42);
  count = 0; release(); gate = null;
  await inflight;
  await refreshPersonalChallenge(quest(), 42, 'wellness');
  assert.equal(fetches, 2, 'the stale in-flight result was not stored');
}));
