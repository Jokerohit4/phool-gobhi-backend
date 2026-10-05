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

-- No users have completed intake, so there is no row whose single `goal` needs
-- folding into the array. Had there been one it would be:
--   UPDATE "health"."HealthGoal" SET "goals" = ARRAY["goal"] WHERE "goals" = ARRAY[]::...;
ALTER TABLE "health"."HealthGoal"
  DROP COLUMN IF EXISTS "goal";

ALTER TABLE "health"."NutritionTarget"
  ADD COLUMN IF NOT EXISTS "goals" "health"."HealthGoalType"[] NOT NULL DEFAULT ARRAY[]::"health"."HealthGoalType"[];

ALTER TABLE "health"."NutritionTarget"
  DROP COLUMN IF EXISTS "goal";