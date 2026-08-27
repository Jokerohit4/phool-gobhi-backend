-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Every GymSubscription that already exists was created before the
-- attendance-SaaS opt-out feature existed, i.e. uniformly under the SaaS
-- honeymoon-commission model — backfill isAttendanceSaas=true for all of
-- them so their (already-paid) per-visit payouts aren't retroactively
-- reinterpreted. New rows set this explicitly at purchase time based on
-- the gym's opt-out status then.

ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "isAttendanceSaas" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "wallet"."PartnerBankSettlement" (
    "id" SERIAL PRIMARY KEY,
    "partnerId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "PartnerBankSettlement_partnerId_settledAt_idx" ON "wallet"."PartnerBankSettlement"("partnerId", "settledAt");
CREATE INDEX IF NOT EXISTS "PartnerBankSettlement_gymId_idx" ON "wallet"."PartnerBankSettlement"("gymId");
