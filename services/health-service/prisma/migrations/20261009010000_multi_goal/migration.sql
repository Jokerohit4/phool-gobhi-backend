-- Multi-goal intake.
--
-- HealthGoal.goal and NutritionTarget.goal were single enum columns, so a user
-- could only record one objective. The engine now reads the whole set (see
-- targetEngine.js: calorie adjustments sum and are then clamped by the same
-- safe-pace bound a single goal is clamped by; protein comes from the single
-- most demanding goal), which means the stored value has to be the set.
--
-- There is deliberately no "primary goal" column to replace these. Nothing
-- consumes one as a driver any more, and a field that tells someone their main
-- goal while changing no number is worse than not having it. The array ORDER is
-- the user's own ranking and is the documented tie-break.
--
-- Empty rather than NULL: an array column with a default is a valid state that
-- the rest of the service can read without special-casing, matching the
-- "skipped the whole setup must be a valid state" contract on this table. Every
-- writer validates at least one goal before it gets here.

ALTER TABLE "health"."HealthGoal"
  ADD COLUMN IF NOT EXISTS "goals" "health"."HealthGoalType"[] NOT NULL DEFAULT ARRAY[]::"health"."HealthGoalType"[];

-- Fold any surviving scalar into the array BEFORE dropping it. This was
-- originally written as a comment claiming no user had completed intake, which
-- was an assumption nobody had checked against the dev database - and this
-- migration drops a column, so being wrong about it is irreversible. The
-- backfill is a no-op on an empty table, so it costs nothing and removes the
-- assumption as a failure mode.
UPDATE "health"."HealthGoal"
  SET "goals" = ARRAY["goal"]
  WHERE "goal" IS NOT NULL
    AND "goals" = ARRAY[]::"health"."HealthGoalType"[];

ALTER TABLE "health"."HealthGoal"
  DROP COLUMN IF EXISTS "goal";

ALTER TABLE "health"."NutritionTarget"
  ADD COLUMN IF NOT EXISTS "goals" "health"."HealthGoalType"[] NOT NULL DEFAULT ARRAY[]::"health"."HealthGoalType"[];

-- Targets are append-only history, so an old row records the goal it was
-- computed for and must not lose it just because it predates the array. Same
-- reason as above: this is history, not a value to discard.
UPDATE "health"."NutritionTarget"
  SET "goals" = ARRAY["goal"]
  WHERE "goal" IS NOT NULL
    AND "goals" = ARRAY[]::"health"."HealthGoalType"[];

ALTER TABLE "health"."NutritionTarget"
  DROP COLUMN IF EXISTS "goal";