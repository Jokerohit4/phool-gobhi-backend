-- AlterTable: new subscriptions pay the partner per completed visit
-- (price/days each), not in full at purchase. Every row that already exists
-- at the time this migration runs was paid out in full under the old model
-- (see purchaseSubscriptionWithWallet) and must never be paid again per
-- visit, so it's explicitly backfilled to "upfront" — only rows created
-- after this migration get the new "perVisit" default.
ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "payoutModel" TEXT NOT NULL DEFAULT 'perVisit';

UPDATE "wallet"."GymSubscription" SET "payoutModel" = 'upfront';
