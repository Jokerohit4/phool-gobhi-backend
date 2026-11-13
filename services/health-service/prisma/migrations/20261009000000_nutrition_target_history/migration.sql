-- NutritionTarget becomes an append-only history.
--
-- The table was created with PRIMARY KEY (userId) and no id / effectiveFrom
-- columns, which contradicted the service: recomputeTargets() orders by
-- `effectiveFrom` to find the newest row and then creates a NEW one, so the
-- orderBy referenced a column that did not exist and a second recompute would
-- have collided with the primary key. The unit tests never caught it because
-- the Prisma double ignored the `where` clause and returned a fabricated `id`.
--
-- Fix: give the table the surrogate key and the effective-date the service has
-- always assumed, and make (userId, effectiveFrom) unique so recomputing twice
-- in one day updates that day instead of leaving two conflicting targets.
--
-- The table is empty (no users have completed intake), so this is a structural
-- change with no data to preserve.

-- 1. The effective-date column the service orders by.
--    'YYYY-MM-DD' text, matching HealthGoal.startDate and
--    BiometricEntry.localDate: the boundary that matters is the user's
--    midnight, not UTC's, so a timestamp would be the wrong type here.
ALTER TABLE "health"."NutritionTarget"
  ADD COLUMN IF NOT EXISTS "effectiveFrom" TEXT;

-- 2. A surrogate key. Cannot be NOT NULL while every existing row is NULL, so
--    it is backfilled first below.
ALTER TABLE "health"."NutritionTarget"
  ADD COLUMN IF NOT EXISTS "id" SERIAL;

-- 3. Drop the old primary key. userId stops being the identity of a row; it
--    becomes a plain foreign key to HealthGoal.userId.
ALTER TABLE "health"."NutritionTarget"
  DROP CONSTRAINT IF EXISTS "NutritionTarget_pkey";

-- 4. Backfill before the NOT NULLs. existing rows (if any survived a deploy
--    race) get the day the ledger was created rather than today, because a
--    target's effective date is a fact about when it was computed and backdating
--    it to the migration day would be a small lie in the history.
UPDATE "health"."NutritionTarget"
   SET "effectiveFrom" = COALESCE("effectiveFrom", '2026-09-27')
 WHERE "effectiveFrom" IS NULL;

-- 5. Now the constraints can hold.
ALTER TABLE "health"."NutritionTarget"
  ALTER COLUMN "id" SET NOT NULL,
  ALTER COLUMN "effectiveFrom" SET NOT NULL;

ALTER TABLE "health"."NutritionTarget"
  ADD CONSTRAINT "NutritionTarget_pkey" PRIMARY KEY ("id");

-- One target per user per day. This is what makes the history safe to append to:
-- a second recompute on the same day collides deliberately and the service
-- upserts, instead of leaving two rows claiming to be today's target.
ALTER TABLE "health"."NutritionTarget"
  DROP CONSTRAINT IF EXISTS "NutritionTarget_userId_effectiveFrom_key";

ALTER TABLE "health"."NutritionTarget"
  ADD CONSTRAINT "NutritionTarget_userId_effectiveFrom_key"
  UNIQUE ("userId", "effectiveFrom");

-- The service's newest-row-per-user lookup is (userId, effectiveFrom DESC),
-- which the unique constraint above already covers as a prefix, so no extra
-- index is needed here.

-- The foreign key to HealthGoal is unchanged: it was and still is on userId
-- alone, because a user has ONE goal set and every row in this history was
-- derived from whatever that set was at the time.