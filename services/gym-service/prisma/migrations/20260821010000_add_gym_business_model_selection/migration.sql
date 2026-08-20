-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying.
--
-- A gym now explicitly participates in either or both business models:
-- marketplace (pay-per-session booking, discovery) and attendance-SaaS
-- (member registration/subscriptions). attendanceSaasOptedOut already
-- covered the SaaS half; marketplaceEnabled adds the missing other half.
-- subscriptionPricingMode + subscriptionFlatFeePerUser let gobhi charge a
-- flat fee per registered user instead of a percentage-of-revenue
-- commission, per gym.

CREATE TYPE "gym"."SubscriptionPricingMode" AS ENUM ('percentage', 'flatPerUser');

ALTER TABLE "gym"."Gym"
  ADD COLUMN IF NOT EXISTS "marketplaceEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "subscriptionPricingMode" "gym"."SubscriptionPricingMode" NOT NULL DEFAULT 'percentage',
  ADD COLUMN IF NOT EXISTS "subscriptionFlatFeePerUser" DECIMAL(10,2);
