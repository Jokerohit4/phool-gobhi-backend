BEGIN;

ALTER TABLE "wallet"."CoachingMembership"
  ADD COLUMN "trainerSessionsRemaining" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nutritionistSessionsRemaining" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "gymSessionsRemaining" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scheduledOrderId" INTEGER,
  ADD CONSTRAINT "CoachingMembership_v2_balances_check" CHECK (
    "trainerSessionsRemaining" >= 0 AND "nutritionistSessionsRemaining" >= 0 AND "gymSessionsRemaining" >= 0
  );
CREATE UNIQUE INDEX "CoachingMembership_scheduledOrderId_key" ON "wallet"."CoachingMembership"("scheduledOrderId");

ALTER TABLE "wallet"."CoachingMembership" DROP CONSTRAINT "CoachingMembership_planType_check";
ALTER TABLE "wallet"."CoachingMembership" ADD CONSTRAINT "CoachingMembership_planType_check" CHECK ((
  "planType" IN ('FREE', 'MONTHLY_4499', 'QUARTERLY_11999') OR (
    "planType" = "offerSnapshot"->>'key' AND "offerSnapshot"->>'schemaVersion' = '2'
    AND "offerSnapshot"->>'family' IN ('medical', 'wellness')
  )
) IS TRUE);

ALTER TABLE "wallet"."CoachingOrder"
  ADD COLUMN "isAddon" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isRenewal" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "termStartsAt" TIMESTAMP(3);
UPDATE "wallet"."CoachingOrder" SET "isAddon" = true WHERE "product" = 'TRAINER_ADDON_1499';

DROP INDEX "wallet"."CoachingOrder_one_pending_plan";
CREATE UNIQUE INDEX "CoachingOrder_one_pending_plan" ON "wallet"."CoachingOrder"("userId")
  WHERE "status" = 'PENDING' AND NOT "isAddon" AND "product" <> 'TRAINER_ADDON_1499';

ALTER TABLE "wallet"."CoachingOrder" DROP CONSTRAINT "CoachingOrder_price_check";
ALTER TABLE "wallet"."CoachingOrder" ADD CONSTRAINT "CoachingOrder_price_check" CHECK ((
  "amountPaise" BETWEEN 1 AND 100000000 AND (
    (
      "offerSnapshot"->>'region' IN ('GURUGRAM', 'REST_INDIA') AND (
        (
          "product" IN ('MONTHLY_4499', 'QUARTERLY_11999', 'TRAINER_ADDON_1499')
          AND "offerSnapshot"->>'product' = "product"
          AND (
            "offerSnapshot"->>'amountPaise' = "amountPaise"::text
            OR "offerSnapshot"#>>'{discount,amountPaise}' = "amountPaise"::text
          )
        ) OR (
          "offerSnapshot"->>'schemaVersion' = '2' AND "offerSnapshot"->>'key' = "product"
          AND "offerSnapshot"#>>'{price,amountPaise}' = "amountPaise"::text
          AND "isAddon" = ("offerSnapshot" ? 'kind')
        )
      )
    ) OR (
      "offerSnapshot" = '{}'::jsonb AND (
        ("product" = 'MONTHLY_4499' AND "amountPaise" = 449900) OR
        ("product" = 'QUARTERLY_11999' AND "amountPaise" = 1199900) OR
        ("product" = 'TRAINER_ADDON_1499' AND "amountPaise" = 149900)
      )
    )
  )
) IS TRUE);

COMMIT;
