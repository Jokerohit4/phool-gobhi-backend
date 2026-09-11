-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying.
--
-- Attendance-SaaS pricing model change: platform default moves from a 1%
-- commission to a flat Rs 1/customer fee (see wallet-service's
-- DEFAULT_SUBSCRIPTION_FLAT_FEE_PER_USER). Applied to every gym immediately,
-- not just new ones going forward — the admin UI to set subscriptionPricingMode
-- per gym never shipped until now, so no gym has ever been deliberately put on
-- percentage mode through the product; this migration just makes the DB match
-- the one model that's actually been offered.

ALTER TABLE "gym"."Gym" ALTER COLUMN "subscriptionPricingMode" SET DEFAULT 'flatPerUser';

UPDATE "gym"."Gym" SET "subscriptionPricingMode" = 'flatPerUser';
