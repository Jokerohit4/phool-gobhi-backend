-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Onboarding branch (2026-09-18): capture who the user is so the app can lead
-- with the right experience. Every column is NULLABLE with no default and no
-- backfill, deliberately: null means "never asked", which is a different fact
-- from any of the enum values. Existing accounts keep behaving exactly as they
-- do today until they answer, and appMode staying null is what makes the
-- Home-tab branch fall through to the current HomeScreen.

-- CreateEnum (idempotent — these run against dev and prod independently)
DO $$ BEGIN
  CREATE TYPE "auth"."TrainingLocationPref" AS ENUM ('home', 'gym', 'fitness_centre', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "auth"."AppMode" AS ENUM ('gym_seeker', 'home_track');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "auth"."FreeTimeWindow" AS ENUM ('morning', 'afternoon', 'evening', 'late_night', 'flexible');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "currentlyWorksOut" BOOLEAN;
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "trainingLocationPref" "auth"."TrainingLocationPref";
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "trainingLocationOther" TEXT;
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "appMode" "auth"."AppMode";
ALTER TABLE "auth"."User" ADD COLUMN IF NOT EXISTS "freeTimeWindow" "auth"."FreeTimeWindow";
