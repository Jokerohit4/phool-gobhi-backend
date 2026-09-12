import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Mirrors wallet-service's credit/debit ledger pattern exactly (same
// idempotencyKey @unique + atomic check-and-decrement + upsert-on-credit /
// throw-on-missing-for-debit asymmetry) — deliberately, so the mental model
// transfers, even though this is a fully separate, non-monetary currency.
// Coins never touch Wallet/WalletTransaction from this service; the only
// place coins interact with real money is later, in the subscription-discount
// flow (Phase 2), where booking-service reduces what it charges the wallet —
// it never asks this service to credit a wallet.

function serializeBalance(balance) {
  if (!balance) return null;
  return { userId: balance.userId, balance: balance.balance, updatedAt: balance.updatedAt };
}

async function alreadyApplied(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const entry = await prisma.coinLedgerEntry.findUnique({ where: { idempotencyKey } });
  if (!entry || entry.userId !== userId) return null;
  return serializeBalance(await prisma.coinBalance.findUnique({ where: { userId } }));
}

// The actual atomic decrement, factored out so a caller that already holds
// its own transaction (e.g. coinCatalogService's customer-redemption path,
// where an inventory-cap check and the coin debit must commit or fail
// together as one unit) can run it inside THAT transaction instead of
// opening a second, nested one — Prisma's interactive transactions don't
// nest, and a debit that committed separately from the cap check it was
// supposed to be conditioned on would defeat the point of checking at all.
//
// No idempotency pre-check in here: the caller's own transaction is the
// unit of retry and idempotency. A duplicate call still can't double-debit
// (the same atomic updateMany guard applies), it just surfaces as
// "Insufficient coins" or a unique-constraint error on the ledger insert
// instead of a clean early return — which is fine, because a caller with
// its own transaction also has its own idempotency check upstream (see
// redeemCatalogItemByUserService).
export async function debitCoinsInTx(tx, userId, amount, description, idempotencyKey = null) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive finite number');
  }
  // Atomic check-and-decrement under the row lock — the balance can't go
  // negative even under concurrent debits, because the WHERE clause and the
  // decrement happen in one statement.
  const { count } = await tx.coinBalance.updateMany({
    where: { userId, balance: { gte: amount } },
    data: { balance: { decrement: amount } },
  });
  if (count === 0) throw new Error('Insufficient coins');
  const updated = await tx.coinBalance.findUnique({ where: { userId } });
  await tx.coinLedgerEntry.create({
    data: { userId, type: 'debit', amount, description, idempotencyKey },
  });
  return updated;
}

export async function creditCoinsService(userId, amount, description, idempotencyKey = null) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive finite number');
  }
  const already = await alreadyApplied(userId, idempotencyKey);
  if (already) return already;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.coinBalance.upsert({ where: { userId }, update: {}, create: { userId, balance: 0 } });
      const updated = await tx.coinBalance.update({
        where: { userId },
        data: { balance: { increment: amount } },
      });
      await tx.coinLedgerEntry.create({
        data: { userId, type: 'credit', amount, description, idempotencyKey },
      });
      return updated;
    });
    return serializeBalance(updated);
  } catch (err) {
    if (idempotencyKey && err.code === 'P2002') return alreadyApplied(userId, idempotencyKey);
    throw err;
  }
}

export async function debitCoinsService(userId, amount, description, idempotencyKey = null) {
  const already = await alreadyApplied(userId, idempotencyKey);
  if (already) return already;
  try {
    const updated = await prisma.$transaction((tx) => debitCoinsInTx(tx, userId, amount, description, idempotencyKey));
    return serializeBalance(updated);
  } catch (err) {
    if (idempotencyKey && err.code === 'P2002') return alreadyApplied(userId, idempotencyKey);
    throw err;
  }
}

export async function getCoinBalanceService(userId) {
  const balance = await prisma.coinBalance.findUnique({ where: { userId } });
  return serializeBalance(balance) || { userId, balance: 0, updatedAt: null };
}

export async function getCoinLedgerService(userId, limit = 50) {
  return prisma.coinLedgerEntry.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
