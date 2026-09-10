// DPDPA erasure for the gamification layer. Two properties matter here and
// neither is obvious from reading the service:
//
//  1. ORDER. RewardIssuance -> ChallengeEnrollment is RESTRICT in the
//     database (verified against the live constraint, not inferred from
//     Prisma defaults). Deleting enrollments before their reward issuances
//     throws a foreign-key violation, and because auth-service refuses to
//     delete the identity row when a downstream erasure fails, the user's
//     account deletion fails permanently. That was a real bug; this test is
//     what stops it coming back.
//
//  2. WHAT SURVIVES. A caught sprout is world state (a spent spawn must not
//     become catchable again) AND a record of where a named person stood.
//     The row stays, the person is removed from it. And a fulfilled
//     CoinRedemption is a financial record with statutory retention, so it
//     must NOT be deleted.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Recorded in call order, which is the whole point for property (1).
let calls = [];
let enrollmentRows = [];
let redemptionCount = 0;

function resetFakes() {
  calls = [];
  enrollmentRows = [{ id: 501 }, { id: 502 }];
  redemptionCount = 3;
}

let eraseUserService;

test('setup: mock prisma once, import erasureService once', async (t) => {
  const record = (model, op) => async (args) => {
    calls.push({ model, op, args });
    return { count: 1 };
  };

  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.challengeEnrollment = {
            findMany: async () => enrollmentRows,
            deleteMany: record('challengeEnrollment', 'deleteMany'),
          };
          this.coinRedemption = { count: async () => redemptionCount };
          // $transaction gets an array of already-built "operations" — with
          // these fakes each is a resolved promise, so recording happens at
          // build time and `calls` preserves the array's order.
          this.$transaction = async (ops) => Promise.all(ops);
          for (const model of [
            'challengeCheckpointVisit', 'rewardIssuance', 'challengeTeamMember',
            'challengeWinner', 'attendanceEventLog', 'userStreakWeek', 'userStreak',
            'coinLedgerEntry', 'coinBalance', 'pairedStreak',
          ]) {
            this[model] = { deleteMany: record(model, 'deleteMany') };
          }
          this.sproutSpawn = { updateMany: record('sproutSpawn', 'updateMany') };
        }
      },
      Prisma: {},
    },
  });

  ({ eraseUserService } = await import('../services/erasureService.js'));
  assert.equal(typeof eraseUserService, 'function');
});

test('reward issuances are deleted BEFORE the enrollments they point at', async () => {
  resetFakes();
  await eraseUserService(77);

  const order = calls.map((c) => c.model);
  const reward = order.indexOf('rewardIssuance');
  const enrollment = order.indexOf('challengeEnrollment');

  assert.notEqual(reward, -1, 'rewardIssuance must be deleted at all');
  assert.ok(
    reward < enrollment,
    'RewardIssuance -> ChallengeEnrollment is RESTRICT: deleting enrollments first '
      + 'throws a FK violation and the account can never be deleted',
  );

  // Scoped to this user's enrollments, never a blanket delete.
  const rewardCall = calls.find((c) => c.model === 'rewardIssuance');
  assert.deepEqual(rewardCall.args.where, { enrollmentId: { in: [501, 502] } });
});

test('checkpoint visits also go before their enrollments', async () => {
  resetFakes();
  await eraseUserService(77);

  const order = calls.map((c) => c.model);
  assert.ok(
    order.indexOf('challengeCheckpointVisit') < order.indexOf('challengeEnrollment'),
    'a visit carries a lat/lng and must not be orphaned or block the enrollment delete',
  );
});

test('a user with no enrollments skips the enrollment-scoped deletes cleanly', async () => {
  resetFakes();
  enrollmentRows = [];
  await eraseUserService(77);

  const order = calls.map((c) => c.model);
  // `{ in: [] }` would be a harmless no-op, but building the call at all is
  // wasted work — and more importantly the service must not throw here, since
  // most users have never joined a challenge.
  assert.ok(!order.includes('rewardIssuance'));
  assert.ok(!order.includes('challengeCheckpointVisit'));
  assert.ok(order.includes('coinBalance'), 'the rest of the erasure still has to run');
});

test('a caught sprout is anonymised, not deleted', async () => {
  resetFakes();
  await eraseUserService(77);

  const spawn = calls.find((c) => c.model === 'sproutSpawn');
  assert.ok(spawn, 'caughtByUserId is a lat/lng plus a timestamp for a named person');
  assert.equal(spawn.op, 'updateMany',
      'deleting the row would resurrect a spent spawn for every other player');
  assert.deepEqual(spawn.args.where, { caughtByUserId: 77 });
  assert.deepEqual(spawn.args.data, { caughtByUserId: null });
  // caughtAt is deliberately left alone: "caught, by nobody in particular" is
  // the state that is both true and anonymous.
  assert.ok(!('caughtAt' in spawn.args.data));
});

test('fulfilled coin redemptions are retained and reported, never deleted', async () => {
  resetFakes();
  const result = await eraseUserService(77);

  assert.ok(!calls.some((c) => c.model === 'coinRedemption'),
      'a redemption fulfilled against real money is a financial record with statutory retention');
  assert.equal(result.redemptionsRetainedForFinancialRecord, 3,
      'retention has to be reported, not invisible');
  assert.equal(result.erased, true);
  assert.equal(result.enrollmentsRemoved, 2);
});

test('everything keyed to the user is covered, both sides of the shared rows', async () => {
  resetFakes();
  await eraseUserService(77);

  const touched = new Set(calls.map((c) => c.model));
  for (const model of [
    'challengeTeamMember', 'challengeWinner', 'attendanceEventLog',
    'userStreakWeek', 'userStreak', 'coinLedgerEntry', 'coinBalance', 'pairedStreak',
  ]) {
    assert.ok(touched.has(model), `${model} holds this user's data and must be erased`);
  }

  // A paired streak belongs to two people and cannot continue with one gone,
  // so it must match on either side rather than only userAId.
  const paired = calls.find((c) => c.model === 'pairedStreak');
  assert.deepEqual(paired.args.where, { OR: [{ userAId: 77 }, { userBId: 77 }] });
});
