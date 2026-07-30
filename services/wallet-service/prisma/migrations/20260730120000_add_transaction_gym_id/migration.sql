-- Hand-authored migration (no DATABASE_URL/shadow DB available). Same
-- caveat as the preceding migrations: reconcile against the actual
-- dev/prod DB before applying.
--
-- Lets a partner with multiple gyms trace which gym a given wallet credit
-- came from — nullable since it's part of multi-gym support and existing
-- rows (and non-gym transaction types like top-ups/manual payouts) have no
-- gym to attribute.

ALTER TABLE "wallet"."WalletTransaction" ADD COLUMN IF NOT EXISTS "gymId" INTEGER;

CREATE INDEX IF NOT EXISTS "WalletTransaction_gymId_idx" ON "wallet"."WalletTransaction"("gymId");
