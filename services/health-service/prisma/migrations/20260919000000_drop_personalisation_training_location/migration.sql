-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Drops PersonalisationProfile.trainingLocation and its enum (2026-09-19).
--
-- DESTRUCTIVE, deliberately, and safe for a specific reason: nothing ever read
-- this column. It was written by one route and included in the DPDPA export,
-- but no code in this service, the customer app, the partner app or the
-- website ever read it to make a decision — so no user's experience was ever
-- influenced by its value, and no behaviour changes by removing it.
--
-- It duplicated auth-service's User.appMode, which IS read (the customer app
-- branches its Home tab on it). Two independently-settable fields meaning the
-- same thing is how you end up with a user whose home screen and whose
-- training engine disagree; this removes that possibility rather than
-- documenting it.
--
-- Checked before writing this: health."PersonalisationProfile" had 0 rows on
-- dev, so nothing was lost there. Verify prod is likewise empty (or that you
-- accept the loss) before promoting to main — these values are unrecoverable
-- afterwards.
--
-- The route (PUT /personalisation/training-location), its controller and its
-- service function are removed in the same commit, so nothing is left writing
-- to a column that no longer exists.

ALTER TABLE "health"."PersonalisationProfile" DROP COLUMN IF EXISTS "trainingLocation";

-- Dropped after the column that used it. Guarded because a re-run, or a prod
-- database where the enum was never created, must not fail the deploy.
DROP TYPE IF EXISTS "health"."TrainingLocation";
