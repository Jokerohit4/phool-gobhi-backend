CREATE TYPE "auth"."WorkoutIntent" AS ENUM ('workout', 'wellness_only');

ALTER TABLE "auth"."User"
ADD COLUMN "workoutIntent" "auth"."WorkoutIntent";
