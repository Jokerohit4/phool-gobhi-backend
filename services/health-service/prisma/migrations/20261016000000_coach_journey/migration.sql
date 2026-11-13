-- Coach journey: the daily habits (water, supplements), the journey's own
-- start-of-record and pause/quit state, the coach consent row, and the content
-- tables the journey reads.
--
-- Additive only. Every new column is nullable or defaulted, and no existing
-- row is backfilled: a prescription written before slots existed has no slot
-- list, and a plan item written before the journey has no layer — both are
-- honest nulls, not a guess about what someone meant.
SET lock_timeout = '3s';

-- Prescription: the calorie budget becomes nullable (until height + weight give
-- a NutritionTarget) and the week's workout shape moves onto the row.
ALTER TABLE "health"."Prescription" ALTER COLUMN "kcal" DROP NOT NULL;
ALTER TABLE "health"."Prescription" ADD COLUMN IF NOT EXISTS "workoutSlots" JSONB;

-- PlanItem: which journey layer the item belongs to.
ALTER TABLE "health"."PlanItem" ADD COLUMN IF NOT EXISTS "layerKey" TEXT;

-- Exercise: the difficulty tag the journey filters the library by.
ALTER TABLE "health"."Exercise" ADD COLUMN IF NOT EXISTS "difficulty" TEXT;

CREATE TABLE IF NOT EXISTS "health"."WaterLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "localDate" TEXT NOT NULL,
    "ml" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaterLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WaterLog_userId_localDate_idx" ON "health"."WaterLog"("userId", "localDate");

CREATE TABLE IF NOT EXISTS "health"."SupplementSchedule" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "times" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplementSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SupplementSchedule_userId_idx" ON "health"."SupplementSchedule"("userId");

CREATE TABLE IF NOT EXISTS "health"."SupplementLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "scheduleId" INTEGER,
    "name" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplementLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SupplementLog_userId_localDate_idx" ON "health"."SupplementLog"("userId", "localDate");

CREATE TABLE IF NOT EXISTS "health"."JourneyProgress" (
    "userId" INTEGER NOT NULL,
    "startLevel" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlocked" JSONB NOT NULL,
    "foodEarlyAt" TIMESTAMP(3),
    "easyStartUntil" TEXT,
    "quitReason" TEXT,
    "lastShowedUpDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JourneyProgress_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."CoachConsent" (
    "userId" INTEGER NOT NULL,
    "scopes" TEXT[],
    "policyVersions" JSONB NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachConsent_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."ExerciseContent" (
    "id" SERIAL NOT NULL,
    "exerciseId" INTEGER NOT NULL,
    "lang" TEXT NOT NULL,
    "steps" TEXT[],
    "feelCues" TEXT[],
    "mistakes" TEXT[],
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExerciseContent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExerciseContent_exerciseId_lang_key" ON "health"."ExerciseContent"("exerciseId", "lang");

CREATE TABLE IF NOT EXISTS "health"."CoachArticle" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachArticle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CoachArticle_slug_lang_key" ON "health"."CoachArticle"("slug", "lang");
