CREATE TYPE "booking"."BookingCoverage" AS ENUM ('entitlement', 'addon');
CREATE TYPE "booking"."BookingPayoutTiming" AS ENUM ('checkin', 'completion');

CREATE TABLE "booking"."GymEntitlement" (
    "id" SERIAL PRIMARY KEY,
    "customerId" INTEGER NOT NULL,
    "orderRef" TEXT NOT NULL UNIQUE,
    "offerKey" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "region" TEXT NOT NULL,
    "requiresClearance" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "GymEntitlement_customerId_status_region_endsAt_idx"
    ON "booking"."GymEntitlement"("customerId", "status", "region", "endsAt");

CREATE TABLE "booking"."GymEntitlementCancellation" (
    "orderRef" TEXT PRIMARY KEY
);

CREATE TABLE "booking"."GymAddonBalance" (
    "id" SERIAL PRIMARY KEY,
    "customerId" INTEGER NOT NULL,
    "termOrderRef" TEXT NOT NULL UNIQUE,
    "remaining" INTEGER NOT NULL DEFAULT 0 CHECK ("remaining" >= 0),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3)
);
CREATE INDEX "GymAddonBalance_customerId_expiresAt_idx"
    ON "booking"."GymAddonBalance"("customerId", "expiresAt");

CREATE TABLE "booking"."GymAddonGrant" (
    "idempotencyKey" TEXT PRIMARY KEY
);

CREATE TABLE "booking"."MembershipPayoutConfig" (
    "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
    "payoutPaise" INTEGER NOT NULL DEFAULT 7500 CHECK ("payoutPaise" > 0),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER
);
INSERT INTO "booking"."MembershipPayoutConfig" ("updatedAt") VALUES (CURRENT_TIMESTAMP);

ALTER TABLE "booking"."Booking"
    ADD COLUMN "coverage" "booking"."BookingCoverage",
    ADD COLUMN "entitlementId" INTEGER REFERENCES "booking"."GymEntitlement"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN "addonBalanceId" INTEGER REFERENCES "booking"."GymAddonBalance"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN "payoutTiming" "booking"."BookingPayoutTiming" NOT NULL DEFAULT 'completion',
    ADD COLUMN "payoutPartnerId" INTEGER,
    ADD COLUMN "payoutReversedAt" TIMESTAMP(3);

CREATE INDEX "booking_owed_checkin_payout_idx" ON "booking"."Booking"("id")
    WHERE "payoutTiming" = 'checkin' AND "payoutCreditedAt" IS NULL AND "payoutAmount" IS NOT NULL;
