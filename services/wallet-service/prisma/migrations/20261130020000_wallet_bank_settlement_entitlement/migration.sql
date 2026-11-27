ALTER TABLE "wallet"."PartnerBankSettlement"
    ALTER COLUMN "subscriptionId" DROP NOT NULL,
    ADD COLUMN "entitlementId" INTEGER,
    ADD COLUMN "addonBalanceId" INTEGER,
    ADD COLUMN "reversedAt" TIMESTAMP(3),
    ADD CONSTRAINT "PartnerBankSettlement_one_coverage_reference"
        CHECK (num_nonnulls("subscriptionId", "entitlementId", "addonBalanceId") = 1);

-- Legacy subscription rows may already contain duplicates. Network rows
-- start with one durable settlement receipt per booking.
CREATE UNIQUE INDEX "PartnerBankSettlement_network_booking_key"
    ON "wallet"."PartnerBankSettlement"("bookingId") WHERE "subscriptionId" IS NULL;

CREATE INDEX "CoachingFulfillment_owed_gym_sync_idx" ON "wallet"."CoachingFulfillment"("updatedAt", "id")
    WHERE "kind" = 'GYM_ENTITLEMENT_SYNC' AND "status" = 'PENDING';
