-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Google rating: linked once via Places autocomplete at gym create/edit time
-- (placesService.js), refreshable on demand from the partner dashboard
-- (refreshGoogleRating). Category ratings: per-category averages recomputed
-- alongside rating/ratingCount whenever a GymReview is added/removed
-- (gymService.addReview/deleteReview) — nullable since a review can rate
-- some categories and skip others.

ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "googlePlaceId" TEXT;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "googleRating" DOUBLE PRECISION;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "googleRatingCount" INTEGER;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "googleRatingUpdatedAt" TIMESTAMP(3);

ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "equipmentRating" DOUBLE PRECISION;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "equipmentRatingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "cleanlinessRating" DOUBLE PRECISION;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "cleanlinessRatingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "trainerRating" DOUBLE PRECISION;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "trainerRatingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "valueForMoneyRating" DOUBLE PRECISION;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "valueForMoneyRatingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "staffBehaviourRating" DOUBLE PRECISION;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "staffBehaviourRatingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "crowdRating" DOUBLE PRECISION;
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "crowdRatingCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "gym"."GymReview" ADD COLUMN IF NOT EXISTS "equipmentRating" DOUBLE PRECISION;
ALTER TABLE "gym"."GymReview" ADD COLUMN IF NOT EXISTS "cleanlinessRating" DOUBLE PRECISION;
ALTER TABLE "gym"."GymReview" ADD COLUMN IF NOT EXISTS "trainerRating" DOUBLE PRECISION;
ALTER TABLE "gym"."GymReview" ADD COLUMN IF NOT EXISTS "valueForMoneyRating" DOUBLE PRECISION;
ALTER TABLE "gym"."GymReview" ADD COLUMN IF NOT EXISTS "staffBehaviourRating" DOUBLE PRECISION;
ALTER TABLE "gym"."GymReview" ADD COLUMN IF NOT EXISTS "crowdRating" DOUBLE PRECISION;
