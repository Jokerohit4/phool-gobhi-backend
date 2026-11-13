ALTER TABLE "health"."JourneyProgress"
  ADD COLUMN "wellnessOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "wellnessFocuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "wellnessDayPattern" TEXT,
  ADD COLUMN "wellnessSleepPattern" TEXT;
