import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const rows = [];
const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
const whereMatches = (where = {}) => row => matches(row, where);
let record, reverse, settle, getMine;

before(async t => {
  const ledger = {
    create: async ({ data }) => {
      if (data.subscriptionId == null && rows.some(row => row.bookingId === data.bookingId && row.subscriptionId === null)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const row = {
        ...data, id: rows.length + 1, createdAt: new Date(), settledAt: null, reversedAt: null,
        subscriptionId: data.subscriptionId ?? null, entitlementId: data.entitlementId ?? null, addonBalanceId: data.addonBalanceId ?? null,
      };
      rows.push(row);
      return { ...row };
    },
    findFirst: async ({ where }) => rows.find(whereMatches(where)) ?? null,
    findMany: async ({ where }) => rows.filter(whereMatches(where)),
    updateMany: async ({ where, data }) => {
      const matched = rows.filter(whereMatches(where));
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
    },
  };
  t.mock.module('../db/prisma.js', { exports: { default: { partnerBankSettlement: ledger } } });
  ({
    recordPendingBankSettlementService: record,
    reverseNetworkBankSettlementService: reverse,
    settleBankSettlementsService: settle,
    getMyBankSettlementsService: getMine,
  } = await import('../services/walletService.js'));
});

const visit = { bookingId: 50, partnerId: 51, gymId: 52, amount: 75 };

test('network bank settlement deduplicates concurrent writes for an entitlement or add-on', async () => {
  rows.length = 0;
  const entitlement = { ...visit, entitlementId: 53 };
  const [first, replay] = await Promise.all([record(entitlement), record(entitlement)]);
  assert.equal(first.id, replay.id);
  assert.equal(replay.subscriptionId, null);
  assert.equal(replay.entitlementId, 53);

  const addon = { ...visit, bookingId: 54, addonBalanceId: 55 };
  await record(addon);
  assert.equal((await record(addon)).addonBalanceId, 55);
  assert.equal(rows.length, 2);
  assert.equal((await getMine(visit.partnerId)).pendingAmount, 150);
  await assert.rejects(() => record({ ...entitlement, amount: 76 }), { status: 409 });
  await assert.rejects(() => record(visit), { status: 400 });
});

test('a pending bank payout can be voided once and a transferred payout returns 409', async () => {
  rows.length = 0;
  const initial = await record({ ...visit, entitlementId: 53 });
  const [first, replay] = await Promise.all([reverse(visit.bookingId), reverse(visit.bookingId)]);
  assert.deepEqual(first, replay);
  assert.equal((await record({ ...visit, entitlementId: 53 })).id, initial.id);
  const legacy = await record({ ...visit, bookingId: 54, subscriptionId: 56 });
  assert.equal(legacy.subscriptionId, 56);
  await record({ ...visit, bookingId: 55, addonBalanceId: 57 });
  assert.equal((await getMine(visit.partnerId)).pendingAmount, 150);
  assert.deepEqual(await settle(visit.partnerId), { settledCount: 2 });
  const result = await getMine(visit.partnerId);
  assert.equal(result.totalSettled, 150);
  assert.ok(result.history.find(row => row.id === initial.id).reversedAt);
  await assert.rejects(() => reverse(55), { status: 409 });
});
