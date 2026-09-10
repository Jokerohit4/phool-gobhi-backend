-- Fitness+ delta (2026-09-08, see phool-gobhi-fitness-plus-BRD.html Tech
-- §3.2): attach WorkoutSession to the booking/gym/day it belongs to, and add
-- the two fields the quick-log sheet captures at finish time. All columns
-- nullable, no backfill — this feature has not launched, so every existing
-- WorkoutSession row is dev/test data only.
CREATE TYPE "health"."WorkoutType" AS ENUM ('strength', 'cardio', 'hiit', 'yoga_mobility', 'full_body', 'rest');

ALTER TABLE "health"."WorkoutSession"
  ADD COLUMN "bookingId" INTEGER,
  ADD COLUMN "gymId" INTEGER,
  ADD COLUMN "localDate" TEXT,
  ADD COLUMN "type" "health"."WorkoutType",
  ADD COLUMN "rpe" INTEGER;

CREATE INDEX "WorkoutSession_userId_bookingId_idx" ON "health"."WorkoutSession"("userId", "bookingId");
CREATE INDEX "WorkoutSession_userId_localDate_idx" ON "health"."WorkoutSession"("userId", "localDate");
