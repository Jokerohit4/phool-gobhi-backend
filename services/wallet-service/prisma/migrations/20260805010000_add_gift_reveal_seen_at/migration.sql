-- Tracks whether the customer has actually seen the /gift-reveal screen for
-- this closed-out subscription. Without it, the client's hasUnseenGiftReveal
-- check (closedOutAt set AND (giftDaysRemaining > 0 OR bonusPaid)) has
-- nothing to ever flip back to false, so the gift-box FAB and reveal screen
-- resurface on every app launch/tab switch indefinitely.
ALTER TABLE "wallet"."GymSubscription" ADD COLUMN IF NOT EXISTS "giftRevealSeenAt" TIMESTAMP(3);
