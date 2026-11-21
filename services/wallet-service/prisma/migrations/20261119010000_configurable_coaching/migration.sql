CREATE TABLE "wallet"."CoachingCatalogConfig" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "config" JSONB NOT NULL,
  "updatedBy" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoachingCatalogConfig_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoachingCatalogConfig_singleton" CHECK ("id" = 1 AND "version" > 0)
);
CREATE TABLE "wallet"."CoachingCatalogConfigHistory" (
  "id" SERIAL NOT NULL,
  "version" INTEGER NOT NULL,
  "config" JSONB NOT NULL,
  "updatedBy" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachingCatalogConfigHistory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoachingCatalogConfigHistory_version_key" ON "wallet"."CoachingCatalogConfigHistory"("version");
ALTER TABLE "wallet"."CoachingMembership" DROP CONSTRAINT "CoachingMembership_balances_check";
ALTER TABLE "wallet"."CoachingMembership" ADD CONSTRAINT "CoachingMembership_balances_check"
  CHECK ("freeDelightSessionsRemaining" BETWEEN 0 AND 20 AND "labCreditsRemaining" BETWEEN 0 AND 2);
ALTER TABLE "wallet"."CoachingAddonGrant" DROP CONSTRAINT "CoachingAddonGrant_balance_check";
ALTER TABLE "wallet"."CoachingAddonGrant" ADD CONSTRAINT "CoachingAddonGrant_balance_check"
  CHECK ("remaining" >= 0 AND ("remaining" <= 20 OR "orderId" < 0));
ALTER TABLE "wallet"."CoachingOrder" DROP CONSTRAINT "CoachingOrder_price_check";
ALTER TABLE "wallet"."CoachingOrder" ADD CONSTRAINT "CoachingOrder_price_check" CHECK ((
  "product" IN ('MONTHLY_4499', 'QUARTERLY_11999', 'TRAINER_ADDON_1499') AND "amountPaise" BETWEEN 1 AND 100000000 AND (
    ("offerSnapshot"->>'amountPaise' = "amountPaise"::text AND "offerSnapshot"->>'product' = "product" AND "offerSnapshot"->>'region' IN ('GURUGRAM', 'REST_INDIA')) OR
    ("offerSnapshot" = '{}'::jsonb AND (("product" = 'MONTHLY_4499' AND "amountPaise" = 449900) OR ("product" = 'QUARTERLY_11999' AND "amountPaise" = 1199900) OR ("product" = 'TRAINER_ADDON_1499' AND "amountPaise" = 149900)))
  )
) IS TRUE);
