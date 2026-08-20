-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying.
--
-- Snapshot of which pricing mode (percentage vs flat-per-user, see
-- gym-service's Gym.subscriptionPricingMode) applied at purchase time.
-- Backfilled to 'percentage' for every existing row, since flat-per-user
-- pricing didn't exist before this feature.

ALTER TABLE "wallet"."GymSubscription"
  ADD COLUMN IF NOT EXISTS "pricingMode" TEXT NOT NULL DEFAULT 'percentage';
