import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

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