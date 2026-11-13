-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations.
--
-- Retryable partner payouts (2026-10-21). completeBooking/autoComplete flip the
-- booking to `completed` before crediting the partner wallet; if that credit
-- failed it was only console-logged, and because the hourly settlement sweep
-- scans only `status = 'started'` rows there was no path to ever retry it — the
-- partner silently lost that session's share. payoutAmount records what
-- completion owes the partner (null = nothing owed, e.g. an "upfront"
-- subscription with partnerShare null, or a SaaS bank-settlement visit handled
-- by a separate ledger) and payoutCreditedAt when the credit landed, so the
-- sweep can retry every completed-but-unpaid booking under the same
-- idempotency key (booking-payout-<id>). Purely additive, both nullable.

ALTER TABLE "booking"."Booking"
  ADD COLUMN IF NOT EXISTS "payoutAmount" DECIMAL(19,2),
  ADD COLUMN IF NOT EXISTS "payoutCreditedAt" TIMESTAMP(3);
