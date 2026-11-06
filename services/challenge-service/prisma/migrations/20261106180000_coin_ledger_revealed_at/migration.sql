-- Reward moments: remember which coin credits the person has been shown.
-- Idempotent (IF NOT EXISTS) like the other recent migrations in this service.
ALTER TABLE "challenge"."CoinLedgerEntry"
  ADD COLUMN IF NOT EXISTS "revealedAt" TIMESTAMP(3);

-- Everything credited before this migration counts as already seen, so the
-- first launch after the deploy does not celebrate a backlog of old coins.
UPDATE "challenge"."CoinLedgerEntry"
   SET "revealedAt" = "createdAt"
 WHERE "revealedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "CoinLedgerEntry_userId_revealedAt_idx"
  ON "challenge"."CoinLedgerEntry" ("userId", "revealedAt");
