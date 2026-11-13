-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations.
--
-- Retryable cancellation refunds (2026-10-08). A cancellation flips the
-- booking to `cancelled` before crediting the refund; if the credit failed the
-- customer was never refunded and nothing remembered that they were owed.
-- refundDueAmount records what this cancellation owes (null = nothing owed,
-- e.g. a subscription-covered booking) and refundedAt when it was credited, so
-- the hourly settlement sweep can retry every cancelled-but-unrefunded booking
-- under the same idempotency key. Purely additive, both nullable.

ALTER TABLE "booking"."Booking"
  ADD COLUMN IF NOT EXISTS "refundDueAmount" DECIMAL(19,2),
  ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);
