// Tests for services/referralService.js and the referral guards on the
// wallet controller — the ₹50/₹50 first-referral payout, its monthly cap,
// the `bonus` transaction type, the generic-credit rejection of referral
// keys, and the reconciliation of a half-paid pair.
//
// Uses an in-memory mock of the Wallet/WalletTransaction Prisma surface
// (node:test + t.mock.module), so the service's real transaction shape runs
// against the mock: a duplicate idempotencyKey genuinely throws P2002 and the
// cap genuinely counts rows.
//
// Run:
//   node --experimental-test-module-mocks --test test/referralService.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

let creditReferralService, reconcileReferralPayoutsService, REFERRAL_MONTHLY_CAP;
let creditWallet;

let mockPrisma;

// In-memory state, reset before each test's work.
let wallets;      // Map<userId, { id, userId, userType, balance }>
let txRows;       // Array<{ id, walletId, type, amount, description, idempotencyKey, gymId, createdAt }>
let idSeq;
let referredBy;   // Map<userId, referrerId> for auth-service's internal profile

function reset() {
  wallets = new Map();
  txRows = [];
  idSeq = 1;
  referredBy = new Map();
}

function ensureWallet(userId, userType = 'customer') {
  if (!wallets.has(userId)) {
    wallets.set(userId, { id: idSeq++, userId, userType, balance: 0 });
  }
  return wallets.get(userId);
}

function matchesWhere(row, where) {
  if (where.type && row.type !== where.type) return false;
  const key = where.idempotencyKey;
  if (key) {
    if (typeof key === 'string') {
      if (row.idempotencyKey !== key) return false;
    } else {
      if (key.startsWith && !String(row.idempotencyKey).startsWith(key.startsWith)) return false;
      if (key.endsWith && !String(row.idempotencyKey).endsWith(key.endsWith)) return false;
    }
  }
  const created = where.createdAt;
  if (created) {
    const t = row.createdAt.getTime();
    if (created.gte && t < created.gte.getTime()) return false;
    if (created.lt && t >= created.lt.getTime()) return false;
  }
  return true;
}

function makeMockPrisma() {
  return {
    wallet: {
      async upsert({ where, create }) { return ensureWallet(where.userId, create?.userType); },
      async findUnique({ where }) { return wallets.get(where.userId) ?? null; },
      async findUniqueOrThrow({ where }) {
        const w = wallets.get(where.userId);
        if (!w) throw new Error('Wallet not found');
        return w;
      },
      async update({ where, data }) {
        const w = wallets.get(where.userId);
        if (!w) throw new Error('Wallet not found');
        if (data?.balance?.increment != null) w.balance += data.balance.increment;
        if (data?.balance?.decrement != null) w.balance -= data.balance.decrement;
        return w;
      },
    },
    walletTransaction: {
      async findUnique({ where }) {
        return txRows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      },
      async findFirst({ where }) {
        return txRows.find((r) => matchesWhere(r, where)) ?? null;
      },
      async findMany({ where }) {
        return txRows.filter((r) => matchesWhere(r, where));
      },
      async count({ where }) {
        return txRows.filter((r) => matchesWhere(r, where)).length;
      },
      async create({ data }) {
        if (data.idempotencyKey && txRows.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const err = new Error('Unique constraint failed on idempotencyKey');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: idSeq++, createdAt: new Date(), ...data };
        txRows.push(row);
        return row;
      },
    },
    // Real service code always passes a callback; the mock hands it the same
    // object as the tx client (no isolation needed for these assertions).
    async $transaction(fn) { return fn(mockPrisma); },
  };
}

test('setup: mock dependencies and import services', async (t) => {
  reset();
  mockPrisma = makeMockPrisma();

  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class { constructor() { return mockPrisma; } },
      Prisma: {},
    },
  });

  t.mock.module('axios', {
    exports: {
      default: {
        get: async (url) => {
          const id = Number(String(url).split('/internal/')[1]);
          return { data: { data: { referredByUserId: referredBy.get(id) ?? null } } };
        },
        post: async () => ({ data: { data: {} } }),
      },
    },
  });

  t.mock.module('../utils/googleIdToken.js', {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  t.mock.module('../utils/analytics.js', {
    exports: { track: () => {} },
  });

  ({ creditReferralService, reconcileReferralPayoutsService, REFERRAL_MONTHLY_CAP } =
    await import('../services/referralService.js'));
  ({ creditWallet } = await import('../controllers/walletController.js'));

  assert.equal(typeof creditReferralService, 'function');
  assert.equal(typeof reconcileReferralPayoutsService, 'function');
  assert.equal(typeof creditWallet, 'function');
});

function callController(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
    };
    handler(req, res);
  });
}

// =========================================================================
// creditReferralService
// =========================================================================

test('credit: pays both sides once, then a double call is already_credited', async () => {
  reset();
  const first = await creditReferralService({ referrerId: 1, friendId: 2, trigger: 'first_booking' });
  assert.equal(first.status, 'credited');
  assert.equal(wallets.get(1).balance, 50);
  assert.equal(wallets.get(2).balance, 50);

  // Type is `bonus` on both rows, amount ₹50.
  const bonusRows = txRows.filter((r) => r.type === 'bonus');
  assert.equal(bonusRows.length, 2);
  assert.ok(bonusRows.every((r) => r.amount === 50));
  assert.ok(txRows.some((r) => r.idempotencyKey === 'referral-credit-referrer-1-for-2'));
  assert.ok(txRows.some((r) => r.idempotencyKey === 'referral-credit-referred-2'));

  const second = await creditReferralService({ referrerId: 1, friendId: 2, trigger: 'first_booking' });
  assert.equal(second.status, 'already_credited');
  assert.equal(wallets.get(1).balance, 50);
  assert.equal(wallets.get(2).balance, 50);
  assert.equal(txRows.length, 2);
});

test('cap: 11th referral in the month is capped, friend still paid', async () => {
  reset();
  const now = new Date();
  // Seed 10 referrer credits this month for referrer 1.
  for (let i = 1; i <= REFERRAL_MONTHLY_CAP; i += 1) {
    txRows.push({
      id: idSeq++, walletId: 99, type: 'bonus', amount: 50,
      description: 'Referral bonus', idempotencyKey: `referral-credit-referrer-1-for-${i}`,
      gymId: null, createdAt: now,
    });
  }

  const result = await creditReferralService({ referrerId: 1, friendId: 20, trigger: 'home_days' });
  assert.equal(result.status, 'capped');
  // Friend is still credited ₹50...
  assert.equal(wallets.get(20).balance, 50);
  // ...but the referrer is not.
  assert.ok(!txRows.some((r) => r.idempotencyKey === 'referral-credit-referrer-1-for-20'));
});

test('validates ids — rejects missing / identical referrer and friend', async () => {
  reset();
  await assert.rejects(() => creditReferralService({ friendId: 2 }), { status: 400 });
  await assert.rejects(() => creditReferralService({ referrerId: 2 }), { status: 400 });
  await assert.rejects(() => creditReferralService({ referrerId: 3, friendId: 3 }), { status: 400 });
});

// =========================================================================
// generic credit route guard
// =========================================================================

test('creditWallet route: rejects referral-credit-* idempotency keys (400)', async () => {
  reset();
  const res = await callController(creditWallet, {
    params: { userId: '2' },
    body: { amount: 50, description: 'Referral bonus', idempotencyKey: 'referral-credit-referred-2' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /referrals\/credit/i);
  assert.equal(txRows.length, 0);
});

// =========================================================================
// reconcileReferralPayoutsService
// =========================================================================

test('reconcile: pays the missing referrer side of a half-paid pair, then no-ops', async () => {
  reset();
  const now = new Date();
  // Friend side already paid, referrer side missing.
  wallets.set(2, { id: 1, userId: 2, userType: 'customer', balance: 50 });
  txRows.push({
    id: idSeq++, walletId: 1, type: 'bonus', amount: 50, description: 'Referral bonus',
    idempotencyKey: 'referral-credit-referred-2', gymId: null, createdAt: now,
  });
  referredBy.set(2, 1);

  const result = await reconcileReferralPayoutsService();
  assert.equal(result.fixed, 1);
  assert.equal(wallets.get(1).balance, 50);
  assert.ok(txRows.some((r) => r.idempotencyKey === 'referral-credit-referrer-1-for-2'));

  // Second sweep: the pair is complete, nothing to fix.
  const again = await reconcileReferralPayoutsService();
  assert.equal(again.fixed, 0);
});

test('reconcile: pays the missing friend side of a reverse half-pair', async () => {
  reset();
  const now = new Date();
  // Referrer side already paid, friend side missing.
  txRows.push({
    id: idSeq++, walletId: 9, type: 'bonus', amount: 50, description: 'Referral bonus',
    idempotencyKey: 'referral-credit-referrer-5-for-7', gymId: null, createdAt: now,
  });

  const result = await reconcileReferralPayoutsService();
  assert.equal(result.fixed, 1);
  assert.equal(wallets.get(7).balance, 50);
  assert.ok(txRows.some((r) => r.idempotencyKey === 'referral-credit-referred-7'));
});
