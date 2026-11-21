ALTER TABLE "wallet"."CoachingMembership" ADD COLUMN "offerSnapshot" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "wallet"."CoachingOrder" ADD COLUMN "offerSnapshot" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "wallet"."CoachingOrder" DROP CONSTRAINT "CoachingOrder_price_check";
ALTER TABLE "wallet"."CoachingOrder" ADD CONSTRAINT "CoachingOrder_price_check" CHECK ((
  ("product" = 'TRAINER_ADDON_1499' AND "amountPaise" = 149900) OR
  ("product" IN ('MONTHLY_4499', 'QUARTERLY_11999') AND (
    ("offerSnapshot"->>'region' = 'REST_INDIA' AND "amountPaise" > 0
      AND "offerSnapshot"->>'amountPaise' = "amountPaise"::text) OR
    (COALESCE("offerSnapshot"->>'region', 'GURUGRAM') = 'GURUGRAM' AND (
      ("product" = 'MONTHLY_4499' AND "amountPaise" = 449900) OR
      ("product" = 'QUARTERLY_11999' AND "amountPaise" = 1199900)
    ))
  ))
) IS TRUE);
