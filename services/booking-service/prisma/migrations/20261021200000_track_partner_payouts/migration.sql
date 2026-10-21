-- Track only newly completed payouts. Historical credits cannot safely be
-- inferred, so existing completed bookings remain null and are never repaid.
ALTER TABLE "booking"."Booking"
  ADD COLUMN "payoutAmount" DECIMAL(19,2),
  ADD COLUMN "payoutCreditedAt" TIMESTAMP(3);
