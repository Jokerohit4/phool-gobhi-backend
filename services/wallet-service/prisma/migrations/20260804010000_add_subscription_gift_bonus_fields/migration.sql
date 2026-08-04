ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "giftDaysGranted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "giftDaysRedeemed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "bonusPaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "closedOutAt" TIMESTAMP(3);
