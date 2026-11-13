-- Marketplace fix for the QR-hunt home track (docs/../sprint2/PG-HUNT-001,
-- D-03/D-05/D-06). The gym trial reward is real money — the founder pays
-- each gym its own session rate per redemption — and is capped monthly
-- across all gym tiers combined, so the numbers governing it live in
-- CoinEconomyConfig (admin-editable, no redeploy) rather than as constants.

-- AlterEnum
-- Postgres requires this to run outside the migration's own transaction —
-- Prisma's migration engine handles that automatically for ADD VALUE.
ALTER TYPE "challenge"."CoinCatalogCategory" ADD VALUE 'gym_trial';

-- AlterTable
ALTER TABLE "challenge"."CoinEconomyConfig"
  ADD COLUMN "gymTrialMonthlyCap" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "gymTrialPerUserLimit" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "challenge"."CoinCatalogItem"
  ADD COLUMN "gymId" INTEGER,
  ADD COLUMN "unitCostPaise" INTEGER,
  ADD COLUMN "fundedBy" TEXT;

-- AlterTable
ALTER TABLE "challenge"."CoinRedemption"
  ADD COLUMN "settled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "settledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CoinCatalogItem_category_idx" ON "challenge"."CoinCatalogItem"("category");

-- CreateIndex
CREATE INDEX "CoinRedemption_catalogItemId_status_createdAt_idx" ON "challenge"."CoinRedemption"("catalogItemId", "status", "createdAt");
