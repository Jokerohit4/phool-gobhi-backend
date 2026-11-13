// Opt-in DB test: completing a personal challenge twice (even concurrently, even
// via the progress cache) issues exactly ONE coin credit and ONE rewardIssuance.
// Skipped unless TEST_DATABASE_URL points at a DISPOSABLE Postgres with the challenge schema.
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'requires explicit disposable TEST_DATABASE_URL opt-in';
if (url) {
  process.env.DATABASE_URL = url; // the service's shared client reads this on import
  process.env.CHALLENGE_CACHE_FORCE = '1';
}

test('personal challenge reward is issued once under repeated/concurrent completion', { skip }, async (t) => {
  t.mock.module(new URL('../middleware/requireFeatureFlag.js', import.meta.url).href, { exports: { isFeatureEnabled: async () => true } });
  const { PrismaClient } = await import('@prisma/client');
  const { refreshPersonalChallenge } = await import('../services/personalChallengeService.js');
  const db = new PrismaClient({ datasourceUrl: url });
  const userId = 9_400_001;
  const prevFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => { fetches++; return { ok: true, json: async () => ({ data: { count: 3 } }) }; };
  let def, challenge;
  try {
    def = await db.challengeDefinition.create({ data: {
      key: `test_idem_${Date.now()}`, type: 'water_consistency', category: 'personal_habit', title: 't',
      audiences: ['wellness'], defaultVerificationMethod: 'activity_log',
    } });
    challenge = await db.challenge.create({ data: { challengeDefinitionId: def.id, city: 'Anywhere', targetCount: 3, rewardCoins: 5 } });
    const enrollment = await db.challengeEnrollment.create({ data: { userId, challengeId: challenge.id } });
    const load = () => ({ ...challenge, challengeDefinition: def, enrollments: [enrollment] });

    // Two concurrent completions, then a third replay with a stale "active" snapshot.
    await Promise.all([refreshPersonalChallenge(load(), userId, 'wellness'), refreshPersonalChallenge(load(), userId, 'wellness')]);
    await refreshPersonalChallenge(load(), userId, 'wellness');

    assert.equal(fetches, 1, 'count came from a single cached/single-flight read');
    const ledger = await db.coinLedgerEntry.findMany({ where: { userId } });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].idempotencyKey, `challenge-reward:${enrollment.id}`);
    assert.equal((await db.coinBalance.findUnique({ where: { userId } })).balance, 5);
    assert.equal(await db.rewardIssuance.count({ where: { enrollmentId: enrollment.id } }), 1);
    const row = await db.challengeEnrollment.findUnique({ where: { id: enrollment.id } });
    assert.equal(row.status, 'completed');
    assert.equal(row.progressCount, 3);
  } finally {
    global.fetch = prevFetch;
    const enrollmentIds = (await db.challengeEnrollment.findMany({ where: { userId }, select: { id: true } })).map((e) => e.id);
    await db.rewardIssuance.deleteMany({ where: { enrollmentId: { in: enrollmentIds } } });
    await db.challengeEnrollment.deleteMany({ where: { userId } });
    await db.coinLedgerEntry.deleteMany({ where: { userId } });
    await db.coinBalance.deleteMany({ where: { userId } });
    if (challenge) await db.challenge.delete({ where: { id: challenge.id } });
    if (def) await db.challengeDefinition.delete({ where: { id: def.id } });
    await db.$disconnect();
  }
});
