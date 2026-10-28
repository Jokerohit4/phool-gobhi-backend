ALTER TABLE "auth"."User"
  ADD COLUMN "wellnessFocuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "wellnessDayPattern" TEXT,
  ADD COLUMN "wellnessSleepPattern" TEXT,
  ADD COLUMN "wellnessSetupCompleted" BOOLEAN NOT NULL DEFAULT false;
