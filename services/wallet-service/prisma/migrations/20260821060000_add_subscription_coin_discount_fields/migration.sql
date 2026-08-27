-- Gamification Phase 2: records when a subscription purchase was discounted
-- via a redeemed coin catalog item (challenge-service), so revenue reporting
-- can distinguish "real price charged" from "platform-absorbed discount"
-- without any coin<->wallet conversion ever happening.
ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "coinDiscountAmount" DECIMAL(19,2);
ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "coinDiscountCoins" INTEGER;
