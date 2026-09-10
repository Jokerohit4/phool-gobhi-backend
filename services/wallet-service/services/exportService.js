import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// DPDPA access right (s.11) for wallet and subscriptions, called by
// auth-service's platform-wide export.
//
// Same asymmetry as booking-service and for the same reason: these rows are a
// financial record with statutory retention (Income Tax, PMLA), so they are
// never erased - and data we keep is data the person is entitled to see.
//
// Razorpay order and payment identifiers are included on purpose. They are
// the only handle a customer has to raise a dispute with their bank or with
// Razorpay directly, so withholding them would make the export less useful
// than the payment-provider statement it is meant to complement.
export async function buildExportService(userId) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    include: { transactions: { orderBy: { createdAt: 'asc' } } },
  });

  const subscriptions = await prisma.gymSubscription.findMany({
    where: { customerId: userId },
    orderBy: { createdAt: 'asc' },
  });

  return {
    wallet: wallet
      ? {
          balance: Number(wallet.balance),
          currency: wallet.currency,
          status: wallet.status,
          openedAt: wallet.createdAt,
        }
      : null,
    transactions: (wallet?.transactions ?? []).map((t) => ({
      at: t.createdAt,
      type: t.type,
      amount: Number(t.amount),
      currency: t.currency,
      status: t.status,
      description: t.description,
      gymId: t.gymId,
      razorpayOrderId: t.razorpayOrderId,
      razorpayPaymentId: t.razorpayPaymentId,
    })),
    subscriptions: subscriptions.map((s) => ({
      subscriptionId: s.id,
      gymId: s.gymId,
      planType: s.planType,
      pricePaid: Number(s.price),
      startDate: s.startDate,
      endDate: s.endDate,
      status: s.status,
      giftDaysGranted: s.giftDaysGranted,
      giftDaysRedeemed: s.giftDaysRedeemed,
      coinDiscountAmount: s.coinDiscountAmount === null ? null : Number(s.coinDiscountAmount),
      coinDiscountCoins: s.coinDiscountCoins,
      purchasedAt: s.createdAt,
      razorpayOrderId: s.razorpayOrderId,
    })),
    notIncluded: {
      partnerCommercials:
        'commission percentage, partner share and payout model are the gym\'s business terms, not your personal data',
    },
  };
}
