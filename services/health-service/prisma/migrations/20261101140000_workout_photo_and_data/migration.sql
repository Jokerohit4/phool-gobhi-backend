-- Workout photo + full workout data capture.
ALTER TABLE "health"."WorkoutSession" ADD COLUMN IF NOT EXISTS "activeSeconds" INTEGER;
ALTER TABLE "health"."WorkoutSession" ADD COLUMN IF NOT EXISTS "pausedSeconds" INTEGER;
ALTER TABLE "health"."WorkoutSession" ADD COLUMN IF NOT EXISTS "bodyWeightKg" DOUBLE PRECISION;
ALTER TABLE "health"."WorkoutSession" ADD COLUMN IF NOT EXISTS "photoStoragePath" TEXT;
ALTER TABLE "health"."WorkoutSession" ADD COLUMN IF NOT EXISTS "photoUploadedAt" TIMESTAMP(3);
ALTER TABLE "health"."WorkoutSession" ADD COLUMN IF NOT EXISTS "photoRewardCoins" INTEGER;

ALTER TABLE "health"."WorkoutSet" ADD COLUMN IF NOT EXISTS "restSeconds" INTEGER;
ALTER TABLE "health"."WorkoutSet" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
