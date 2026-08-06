-- Hand-authored migration (same caveat as every prior migration in this
-- service: no shadow DB was available to run `prisma migrate dev`; reconcile
-- against the actual dev/prod DB before applying).
--
-- Adds per-day-of-week operating hours (morning + evening window per day,
-- replacing the single Gym.openTime/closeTime window used by slot
-- generation) and a fully-bookable recurring classes feature.
--
-- IMPORTANT: the backfill INSERT at the bottom of this file is deliberately
-- part of THIS SAME migration, not a separate post-deploy script. It
-- reproduces every existing gym's current single-window behavior exactly
-- (dayOfWeek 0-6, morningStart/End = old openTime/closeTime, evening null)
-- so nothing changes until a partner edits their hours. Splitting it out
-- would create a deploy-ordering window where the new slot-generation code
-- finds no GymOperatingHours rows and shows every gym as fully closed.

ALTER TYPE "gym"."EditRequestType" ADD VALUE IF NOT EXISTS 'operating_hours_update';
ALTER TYPE "gym"."EditRequestType" ADD VALUE IF NOT EXISTS 'class_add';
ALTER TYPE "gym"."EditRequestType" ADD VALUE IF NOT EXISTS 'class_update';
ALTER TYPE "gym"."EditRequestType" ADD VALUE IF NOT EXISTS 'class_delete';

CREATE TABLE "gym"."GymOperatingHours" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "morningStart" TEXT,
    "morningEnd" TEXT,
    "eveningStart" TEXT,
    "eveningEnd" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GymOperatingHours_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GymOperatingHours_gymId_dayOfWeek_key" ON "gym"."GymOperatingHours"("gymId", "dayOfWeek");

ALTER TABLE "gym"."GymOperatingHours" ADD CONSTRAINT "GymOperatingHours_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: a recurring bookable class (e.g. "Yoga", Mon/Wed/Fri 7-8am) —
-- a class held multiple times a week is multiple rows, one per dayOfWeek.
-- price NULL = included with an active subscription at this gym; price set
-- = always charged that amount regardless of subscription status.
CREATE TABLE "gym"."GymClass" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "instructor" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "price" DECIMAL(19,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GymClass_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GymClass_gymId_dayOfWeek_idx" ON "gym"."GymClass"("gymId", "dayOfWeek");

ALTER TABLE "gym"."GymClass" ADD CONSTRAINT "GymClass_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: one-off cancellation of a single occurrence of a recurring
-- GymClass (e.g. instructor sick on a specific date) — mirrors SlotBlock's
-- per-date mechanism for plain slots, scoped to a class instead of a
-- startTime.
CREATE TABLE "gym"."GymClassCancellation" (
    "id" SERIAL NOT NULL,
    "classId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GymClassCancellation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GymClassCancellation_classId_date_key" ON "gym"."GymClassCancellation"("classId", "date");

ALTER TABLE "gym"."GymClassCancellation" ADD CONSTRAINT "GymClassCancellation_classId_fkey" FOREIGN KEY ("classId") REFERENCES "gym"."GymClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: reproduce every existing gym's current single-window behavior
-- across all 7 days. See the file-level comment above — this must ship
-- atomically with the CREATE TABLE statements above.
INSERT INTO "gym"."GymOperatingHours" ("gymId", "dayOfWeek", "morningStart", "morningEnd", "updatedAt")
SELECT g."id", d."dow", g."openTime", g."closeTime", CURRENT_TIMESTAMP
FROM "gym"."Gym" g
CROSS JOIN generate_series(0, 6) AS d("dow")
ON CONFLICT ("gymId", "dayOfWeek") DO NOTHING;
