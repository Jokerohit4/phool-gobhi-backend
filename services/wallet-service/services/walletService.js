import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
const prisma = new PrismaClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Batch-fetches {name, phone} per userId from auth-service's internal
// endpoint so admin views never show a bare numeric userId when real money
// is about to move. Best-effort: a lookup failure degrades to nulls rather
// than blocking the balances/payout view.
async function enrichWithUserInfo(rows) {
  const internalHeaders = { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(AUTH_SERVICE_URL)) } };
  const infoByUserId = await Promise.all(
    rows.map(async (row) => {
      try {
        const res = await axios.get(`${AUTH_SERVICE_URL}/internal/${row.userId}`, internalHeaders);
        return [row.userId, { name: res.data?.name ?? null, phone: res.data?.phone ?? null }];
      } catch (_) {
        return [row.userId, { name: null, phone: null }];
      }
    })
  );
  const infoMap = new Map(infoByUserId);
  return rows.map((row) => ({ ...row, ...infoMap.get(row.userId) }));
}

export async function createWalletService(userId, userType) {
  try {
    return await prisma.wallet.create({
      data: { userId, userType }
    });
  } catch (err) {
    throw new Error('Could not create wallet: ' + err.message);
  }
}

export async function getWalletService(userId) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error('Wallet not found');
  return wallet;
}

export async function getWalletTransactionsService(userId) {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, include: { transactions: true } });
  if (!wallet) throw new Error('Wallet not found');
  return wallet.transactions;
}

export async function creditWalletService(userId, amount, description) {
  return await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');
    const updated = await tx.wallet.update({
      where: { userId },
      data: { balance: { increment: amount } }
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'credit',
        amount,
        description
      }
    });
    return updated;
  });
}

export async function debitWalletService(userId, amount, description) {
  return await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.balance < amount) throw new Error('Insufficient balance');
    const updated = await tx.wallet.update({
      where: { userId },
      data: { balance: { decrement: amount } }
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'debit',
        amount,
        description
      }
    });
    return updated;
  });
}

export async function getPartnerBalancesService() {
  const wallets = await prisma.wallet.findMany({
    where: { userType: 'partner', balance: { gt: 0 } },
    orderBy: { balance: 'desc' }
  });
  return enrichWithUserInfo(wallets);
}

export async function getPayoutHistoryService() {
  const transactions = await prisma.walletTransaction.findMany({
    where: { type: 'payout' },
    include: { wallet: true },
    orderBy: { createdAt: 'desc' }
  });
  const rows = transactions.map((t) => ({
    id: t.id,
    userId: t.wallet.userId,
    amount: t.amount,
    description: t.description,
    createdAt: t.createdAt,
  }));
  return enrichWithUserInfo(rows);
}

export async function payoutWalletService(userId, amount, description) {
  return await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new Error('Wallet not found');
    const payoutAmount = amount ?? wallet.balance;
    if (payoutAmount <= 0) throw new Error('Nothing to pay out');
    if (wallet.balance < payoutAmount) throw new Error('Insufficient balance');
    const updated = await tx.wallet.update({
      where: { userId },
      data: { balance: { decrement: payoutAmount } }
    });
    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'payout',
        amount: payoutAmount,
        description: description || 'Manual payout to partner'
      }
    });
    return { wallet: updated, transaction };
  });
}

export async function createRazorpayOrderService(userId, orderId, amount) {
  try {
    return await prisma.razorpayOrder.create({
      data: {
        userId,
        orderId,
        amount,
        status: 'PENDING'
      }
    });
  } catch (err) {
    throw new Error('Could not create Razorpay order: ' + err.message);
  }
}

export async function getRazorpayOrderService(orderId) {
  try {
    return await prisma.razorpayOrder.findUnique({
      where: { orderId }
    });
  } catch (err) {
    throw new Error('Could not get Razorpay order: ' + err.message);
  }
}

export async function claimRazorpayOrderService(orderId) {
  // Atomic UPDATE...WHERE status='PENDING' — the DB row lock makes this the
  // single point of truth for "who gets to credit this order," so the client
  // /verify call and the webhook can never both credit the same top-up.
  const result = await prisma.razorpayOrder.updateMany({
    where: { orderId, status: 'PENDING' },
    data: { status: 'PROCESSING' }
  });
  return result.count === 1;
}

export async function updateRazorpayOrderStatusService(orderId, status, razorpayPaymentId = null) {
  try {
    const data = { status };
    if (razorpayPaymentId) {
      data.razorpayPaymentId = razorpayPaymentId;
    }
    return await prisma.razorpayOrder.update({
      where: { orderId },
      data
    });
  } catch (err) {
    throw new Error('Could not update Razorpay order: ' + err.message);
  }
}
