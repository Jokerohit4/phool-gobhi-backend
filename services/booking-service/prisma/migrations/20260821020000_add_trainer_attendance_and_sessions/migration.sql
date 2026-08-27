-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying.
--
-- TrainerAttendance: a gym trainer's own daily check-in (geofence self
-- check-in, one row per trainer per day). TrainingSession: the trainer
-- self-logs which attended customer booking they trained — tied to a real
-- Booking row for provenance, not a freeform/static assignment.

CREATE TABLE "booking"."TrainerAttendance" (
    "id" SERIAL NOT NULL,
    "trainerId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,

    CONSTRAINT "TrainerAttendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrainerAttendance_trainerId_date_key" ON "booking"."TrainerAttendance"("trainerId", "date");
CREATE INDEX "TrainerAttendance_gymId_date_idx" ON "booking"."TrainerAttendance"("gymId", "date");

CREATE TABLE "booking"."TrainingSession" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "trainerId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrainingSession_bookingId_key" ON "booking"."TrainingSession"("bookingId");
CREATE INDEX "TrainingSession_trainerId_gymId_idx" ON "booking"."TrainingSession"("trainerId", "gymId");
CREATE INDEX "TrainingSession_customerId_idx" ON "booking"."TrainingSession"("customerId");
