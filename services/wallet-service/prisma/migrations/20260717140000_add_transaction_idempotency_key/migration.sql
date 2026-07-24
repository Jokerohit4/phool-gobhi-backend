-- Hand-authored migration (no DATABASE_URL/shadow DB available). Same
-- caveat as the preceding migrations: reconcile against the actual
-- dev/prod DB before applying.
--
-- Lets a caller safely retry a credit/debit or reconcile it after a crash
-- (see booking-service's pending-booking reconciliation) without
-- double-applying it.

ALTER TABLE "wallet"."WalletTransaction" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

DO $$ BEGIN
  CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key" ON "wallet"."WalletTransaction"("idempotencyKey");
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;
