-- Hand-authored migration (no DATABASE_URL/shadow DB available). Same caveat
-- as the preceding migrations: reconcile against the actual dev/prod DB
-- before applying.
--
-- Converts Booking.amount from DOUBLE PRECISION (Float) to NUMERIC(19,2)
-- (Decimal) — same class of fix wallet-service already applied to itself
-- (see its wallet_decimal_and_indexes migration). USING cast preserves
-- existing values (rounded to 2dp); safe to run even against rows written
-- before this change.

ALTER TABLE "booking"."Booking"
  ALTER COLUMN "amount" TYPE NUMERIC(19,2) USING "amount"::numeric(19,2);
