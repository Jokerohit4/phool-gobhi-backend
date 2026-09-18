-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Cycle tracking (2026-09-18). A RECORDED OVERRIDE of FR-27, which
-- deliberately kept zero cycle/pregnancy columns server-side — see the schema
-- comment above CycleTrackingProfile for the full reasoning and the three
-- containments that make it reversible.
--
-- Purely additive. Applying this changes nothing for anyone: the tables stay
-- empty until a user both has the cycleTracking flag on AND opts in through
-- the 'cycle_tracking' consent scope.

DO $$ BEGIN
  CREATE TYPE "health"."CyclePhase" AS ENUM ('menstrual', 'follicular', 'ovulation', 'luteal');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."CycleEntrySource" AS ENUM ('user_logged', 'predicted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "health"."CycleTrackingProfile" (
    "userId" INTEGER NOT NULL,
    "consentAt" TIMESTAMP(3),
    "privacyVersion" TEXT,
    "averageCycleLengthDays" INTEGER,
    "averagePeriodLengthDays" INTEGER,
    "lastPeriodStartDate" DATE,
    "managesProgrammingMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CycleTrackingProfile_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."CyclePhaseEntry" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "phase" "health"."CyclePhase" NOT NULL,
    "source" "health"."CycleEntrySource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CyclePhaseEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CyclePhaseEntry_userId_startDate_idx"
  ON "health"."CyclePhaseEntry"("userId", "startDate");
