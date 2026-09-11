// The marketplace fix for the QR-hunt home track (D-03/D-05/D-06,
// docs/../sprint2/PG-HUNT-001). Five properties matter and none is obvious
// from reading the code:
//
//   1. The gym_trial monthly cap and the per-user limit are SHARED across
//      every item in the category, not counted per catalog item — a user
//      who claimed the neighbourhood trial cannot also claim the premium
//      one, and the cap counts all gym tiers together.
//   2. The cap check, the per-user check, the coin debit and the
//      redemption insert are all one transaction. A cap check that passed
//      in a separate call from the debit would race under concurrent
//      redemptions against the last unit of the month.
//   3. A serialization failure (concurrent transactions racing the same
//      cap slot) is retried automatically, not surfaced to the customer.
//   4. Redemptions from a previous calendar month never count toward this
//      month's cap.
//   5. A repeated Idempotency-Key returns the SAME redemption rather than
//      debiting twice — a Rs 300-600 gym pass is not something to risk
//      issuing twice on a retried request.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let catalogItems = [];
let redemptions = [];
let coinBalances = new Map();
let ledgerEntries = [];
let economyConfig = { gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1 };
let nextId = 1;
let txCallCount = 0;
let failTransactionOnAttempts = new Set(); // attempt numbers (1-based) to force a P2034 on

function reset() {
  catalogItems = [];
  redemptions = [];
  coinBalances = new Map();
  ledgerEntries = [];
  economyConfig = { gymTrialMonthlyCap: 10, gymTrialPerUserLimit: 1 };
  nextId = 1;
  txCallCount = 0;
  failTransactionOnAttempts = new Set();
}

function matchesRedemptionWhere(r, where) {
  if (where.status && r.status !== where.status) return false;
  if (where.userId !== undefined && r.userId !== where.userId) return false;
  if (where.createdAt?.gte && r.createdAt < where.createdAt.gte) return false;
  if (where.catalogItem?.category) {
    const item = catalogItems.find((i) => i.id === r.catalogItemId);
    if (item?.category !== where.catalogItem.category) return false;
  }
  return true;
}

function findItem(where) {
  if (where.key !== undefined) return catalogItems.find((i) => i.key === where.key) ?? null;
  if (where.id !== undefined) return catalogItems.find((i) => i.id === where.id) ?? null;
  return null;
}

function dbSurface() {
  return {
    coinCatalogItem: {
      findUnique: async ({ where }) => findItem(where),
      count: async () => catalogItems.length,
      findMany: async ({ where, orderBy } = {}) => {
        let items = catalogItems.filter((i) => (where?.isActive === undefined ? true : i.isActive === where.isActive));
        if (orderBy?.coinCost) items = [...items].sort((a, b) => a.coinCost - b.coinCost);
        if (orderBy?.createdAt) items = [...items].sort((a, b) => a.id - b.id);
        return items;
      },
      create: async ({ data }) => {
        const item = { id: nextId++, isActive: true, gymId: null, unitCostPaise: null, discountAmount: null, fundedBy: null, ...data };
        catalogItems.push(item);
        return item;
      },
      createMany: async ({ data }) => {
        for (const d of data) catalogItems.push({ id: nextId++, isActive: true, gymId: null, unitCostPaise: null, discountAmount: null, fundedBy: null, ...d });
        return { count: data.length };
      },
    },
    coinRedemption: {
      findUnique: async ({ where, include }) => {
        const r =
          (where.idempotencyKey && redemptions.find((r) => r.idempotencyKey === where.idempotencyKey)) ||
          (where.id !== undefined && redemptions.find((r) => r.id === where.id)) ||
          null;
        if (!r) return null;
        return include?.catalogItem ? { ...r, catalogItem: catalogItems.find((i) => i.id === r.catalogItemId) ?? null } : r;
      },
      count: async ({ where }) => redemptions.filter((r) => matchesRedemptionWhere(r, where)).length,
      create: async ({ data, include }) => {
        const r = { id: nextId++, createdAt: new Date(), ...data };
        redemptions.push(r);
        return include?.catalogItem ? { ...r, catalogItem: catalogItems.find((i) => i.id === r.catalogItemId) ?? null } : r;
      },
    },
    coinBalance: {
      updateMany: async ({ where, data }) => {
        const bal = coinBalances.get(where.userId) ?? 0;
        if (bal < where.balance.gte) return { count: 0 };
        coinBalances.set(where.userId, bal - data.balance.decrement);
        return { count: 1 };
      },
      findUnique: async ({ where }) => ({ userId: where.userId, balance: coinBalances.get(where.userId) ?? 0, updatedAt: new Date() }),
      upsert: async ({ where, create }) => {
        if (!coinBalances.has(where.userId)) coinBalances.set(where.userId, create.balance);
        return { userId: where.userId, balance: coinBalances.get(where.userId), updatedAt: new Date() };
      },
    },
    coinLedgerEntry: {
      create: async ({ data }) => {
        ledgerEntries.push(data);
        return data;
      },
      findUnique: async ({ where }) => ledgerEntries.find((e) => e.idempotencyKey === where.idempotencyKey) ?? null,
    },
  };
}

let redeemCatalogItemByUserService, redeemCatalogItemService, listActiveCatalogService, createCatalogItemAdminService;

test('setup: mock prisma + coinEconomyConfigService, import coinCatalogService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      // $transaction defined directly on the class (not patched onto the
      // prototype afterward) so every instance has it from the moment it's
      // constructed — including the module-level singleton coinCatalogService
      // and coinLedgerService each create at import time, before this test
      // callback would otherwise get a chance to patch anything.
      PrismaClient: class {
        constructor() {
          Object.assign(this, dbSurface());
        }
        async $transaction(fn) {
          txCallCount++;
          if (failTransactionOnAttempts.has(txCallCount)) {
            const err = new Error('could not serialize access due to concurrent update');
            err.code = 'P2034';
            throw err;
          }
          return fn(dbSurface());
        }
      },
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    },
  });

  t.mock.module(new URL('../services/coinEconomyConfigService.js', import.meta.url).href, {
    exports: {
      loadEconomyConfig: async () => ({ ...economyConfig }),
    },
  });

  const mod = await import('../services/coinCatalogService.js');
  redeemCatalogItemByUserService = mod.redeemCatalogItemByUserService;
  redeemCatalogItemService = mod.redeemCatalogItemService;
  listActiveCatalogService = mod.listActiveCatalogService;
  createCatalogItemAdminService = mod.createCatalogItemAdminService;
});

function seedSubDiscount() {
  catalogItems.push({ id: nextId++, key: 'sub_discount_50', category: 'subscription_discount', title: '₹50 off', coinCost: 500, isActive: true, discountAmount: 50, gymId: null, unitCostPaise: null });
}
function seedBuddyBoost() {
  catalogItems.push({ id: nextId++, key: 'buddy_boost_50', category: 'buddy_unlock', title: 'Buddy boost', coinCost: 50, isActive: true, discountAmount: null, gymId: null, unitCostPaise: null });
}
function seedGymTrial({ key = 'gym_trial_neighbourhood', coinCost = 150, gymId = 7, unitCostPaise = 30000 } = {}) {
  catalogItems.push({ id: nextId++, key, category: 'gym_trial', title: 'Gym trial', coinCost, isActive: true, discountAmount: null, gymId, unitCostPaise });
}
function fund(userId, coins) {
  coinBalances.set(userId, coins);
}
function existingRedemption({ userId, catalogKey, createdAt = new Date(), status = 'fulfilled' }) {
  const item = catalogItems.find((i) => i.key === catalogKey);
  redemptions.push({ id: nextId++, userId, catalogItemId: item.id, coinCost: item.coinCost, status, metadata: null, idempotencyKey: `seed-${nextId}`, createdAt });
}

test('redeeming buddy_boost_50 (D-03: the cheapest item, reachable from one 90-coin chain) debits exactly 50', async () => {
  reset();
  seedBuddyBoost();
  fund(1, 90);

  const result = await redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'buddy_boost_50', idempotencyKey: 'k1' });

  assert.equal(result.status, 'fulfilled');
  assert.equal(result.coinCost, 50);
  assert.equal(coinBalances.get(1), 40);
});

test('a gym_trial redemption records gymId and unitCostPaise in metadata, snapshotted at redemption time', async () => {
  reset();
  seedGymTrial({ gymId: 42, unitCostPaise: 45000, coinCost: 300 });
  fund(1, 300);

  const result = await redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'gym_trial_neighbourhood', idempotencyKey: 'k1' });

  assert.equal(result.status, 'fulfilled');
  assert.deepEqual(result.metadata, { gymId: 42, unitCostPaise: 45000 });
});

test('insufficient coins is rejected with a specific code, and nothing is debited', async () => {
  reset();
  seedGymTrial({ coinCost: 150 });
  fund(1, 10);

  await assert.rejects(
    () => redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'gym_trial_neighbourhood', idempotencyKey: 'k1' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'INSUFFICIENT_COINS');
      return true;
    }
  );
  assert.equal(coinBalances.get(1), 10);
});

test('the monthly cap is SHARED across every gym_trial item, not counted per item', async () => {
  reset();
  economyConfig.gymTrialMonthlyCap = 2;
  seedGymTrial({ key: 'gym_trial_a', coinCost: 150 });
  seedGymTrial({ key: 'gym_trial_b', coinCost: 300 });
  // Two redemptions already this month, split across the two different tiers.
  existingRedemption({ userId: 101, catalogKey: 'gym_trial_a' });
  existingRedemption({ userId: 102, catalogKey: 'gym_trial_b' });
  fund(1, 300);

  await assert.rejects(
    () => redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'gym_trial_b', idempotencyKey: 'k1' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'GYM_TRIAL_CAP_REACHED');
      return true;
    }
  );
  assert.equal(coinBalances.get(1), 300); // untouched
});

test('the per-user limit is SHARED across tiers: one trial ever, not one per tier', async () => {
  reset();
  seedGymTrial({ key: 'gym_trial_a', coinCost: 150 });
  seedGymTrial({ key: 'gym_trial_b', coinCost: 600 });
  existingRedemption({ userId: 1, catalogKey: 'gym_trial_a' });
  fund(1, 600);

  await assert.rejects(
    () => redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'gym_trial_b', idempotencyKey: 'k1' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'GYM_TRIAL_ALREADY_CLAIMED');
      return true;
    }
  );
});

test('a redemption from LAST calendar month never counts toward this month\'s cap', async () => {
  reset();
  economyConfig.gymTrialMonthlyCap = 1;
  seedGymTrial({ coinCost: 150 });
  const lastMonth = new Date();
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  existingRedemption({ userId: 999, catalogKey: 'gym_trial_neighbourhood', createdAt: lastMonth });
  fund(1, 150);

  const result = await redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'gym_trial_neighbourhood', idempotencyKey: 'k1' });
  assert.equal(result.status, 'fulfilled');
});

test('a repeated Idempotency-Key returns the same redemption and does not debit twice', async () => {
  reset();
  seedBuddyBoost();
  fund(1, 50);

  const first = await redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'buddy_boost_50', idempotencyKey: 'same-key' });
  const second = await redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'buddy_boost_50', idempotencyKey: 'same-key' });

  assert.equal(first.redemptionId, second.redemptionId);
  assert.equal(coinBalances.get(1), 0); // debited once, not twice
});

test('idempotencyKey is required — rejected before touching the database', async () => {
  reset();
  seedBuddyBoost();
  fund(1, 50);

  await assert.rejects(
    () => redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'buddy_boost_50' }),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
  assert.equal(coinBalances.get(1), 50); // untouched
});

test('an unknown or inactive catalog key is a 404', async () => {
  reset();
  fund(1, 500);
  await assert.rejects(
    () => redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'does_not_exist', idempotencyKey: 'k1' }),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('a serialization failure from a concurrent redemption is retried, not surfaced', async () => {
  reset();
  seedBuddyBoost();
  fund(1, 50);
  failTransactionOnAttempts = new Set([1]); // fails once, then succeeds

  const result = await redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'buddy_boost_50', idempotencyKey: 'k1' });

  assert.equal(result.status, 'fulfilled');
  assert.equal(txCallCount, 2); // one failed attempt, one that succeeded
});

test('exhausting every retry surfaces the conflict rather than hanging or silently returning nothing', async () => {
  reset();
  seedBuddyBoost();
  fund(1, 50);
  failTransactionOnAttempts = new Set([1, 2, 3]);

  await assert.rejects(
    () => redeemCatalogItemByUserService({ userId: 1, catalogItemKey: 'buddy_boost_50', idempotencyKey: 'k1' }),
    (err) => {
      assert.equal(err.code, 'P2034');
      return true;
    }
  );
});

test('listActiveCatalogService annotates a gym_trial item with units-remaining and the caller\'s own claim status', async () => {
  reset();
  economyConfig.gymTrialMonthlyCap = 10;
  seedGymTrial({ coinCost: 150 });
  existingRedemption({ userId: 555, catalogKey: 'gym_trial_neighbourhood' }); // someone else's redemption this month
  existingRedemption({ userId: 1, catalogKey: 'gym_trial_neighbourhood' }); // THIS user's own redemption

  const items = await listActiveCatalogService(1);
  const trial = items.find((i) => i.key === 'gym_trial_neighbourhood');

  assert.equal(trial.unitsRemainingThisMonth, 8); // 10 cap - 2 fulfilled this month
  assert.equal(trial.alreadyClaimedByUser, true);
});

test('a non-gym_trial item is returned unannotated', async () => {
  reset();
  seedSubDiscount();
  const items = await listActiveCatalogService(1);
  assert.equal(items[0].unitsRemainingThisMonth, undefined);
  assert.equal(items[0].alreadyClaimedByUser, undefined);
});

test('an empty catalog seeds BOTH sub_discount_50 and buddy_boost_50, not just one', async () => {
  reset();
  const items = await listActiveCatalogService();
  const keys = items.map((i) => i.key).sort();
  assert.deepEqual(keys, ['buddy_boost_50', 'sub_discount_50']);
});

test('createCatalogItemAdminService requires a gymId for a gym_trial item', async () => {
  reset();
  await assert.rejects(
    () => createCatalogItemAdminService({ key: 'x', category: 'gym_trial', title: 'X', coinCost: 100 }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.error, /gymId/);
      return true;
    }
  );
});

test('the internal (wallet-service) redemption path is unaffected: no cap, no per-user check', async () => {
  reset();
  seedSubDiscount();
  fund(1, 500);

  const result = await redeemCatalogItemService({ userId: 1, catalogItemKey: 'sub_discount_50', idempotencyKey: 'k1', metadata: { gymId: 9 } });

  assert.equal(result.status, 'fulfilled');
  assert.equal(result.discountAmount, 50);
  assert.equal(coinBalances.get(1), 0);
});
