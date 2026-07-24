-- Hand-authored migration (no DATABASE_URL/shadow DB available). Same caveat
-- as the preceding migrations: reconcile against the actual dev/prod DB
-- before applying.
--
-- Converts money fields from DOUBLE PRECISION (Float) to NUMERIC(19,2)
-- (Decimal) — same class of fix wallet-service already applied to itself
-- (see its wallet_decimal_and_indexes migration). USING casts preserve
-- existing values (rounded to 2dp); safe to run even against rows written
-- before this change.

ALTER TABLE "gym"."Gym"
  ALTER COLUMN "sessionPrice" TYPE NUMERIC(19,2) USING "sessionPrice"::numeric(19,2),
  ALTER COLUMN "quotedPrice" TYPE NUMERIC(19,2) USING "quotedPrice"::numeric(19,2),
  ALTER COLUMN "weeklyPlanPrice" TYPE NUMERIC(19,2) USING "weeklyPlanPrice"::numeric(19,2),
  ALTER COLUMN "monthlyPlanPrice" TYPE NUMERIC(19,2) USING "monthlyPlanPrice"::numeric(19,2),
  ALTER COLUMN "quarterlyPlanPrice" TYPE NUMERIC(19,2) USING "quarterlyPlanPrice"::numeric(19,2),
  ALTER COLUMN "yearlyPlanPrice" TYPE NUMERIC(19,2) USING "yearlyPlanPrice"::numeric(19,2);

ALTER TABLE "gym"."GymSlotPrice"
  ALTER COLUMN "price" TYPE NUMERIC(19,2) USING "price"::numeric(19,2);
