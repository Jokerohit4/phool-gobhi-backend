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

export async function getPartnerBalancesService() {
  return await prisma.wallet.findMany({
    where: { userType: 'partner', balance: { gt: 0 } },
    orderBy: { balance: 'desc' }
  });
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
