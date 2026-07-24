-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations: reconcile against the actual dev/prod DB before applying.
--
-- Attendance verification feature: a partner's QR scan of the customer's
-- booking QR is now the enforced signal that a session actually happened,
-- required before completeBooking can pay the partner out. See
-- bookingService.verifyAttendance / completeBooking and docs in the
-- attendance-system plan for the full flow.
--
-- Platform is pre-launch — no real production rows to backfill.

DO $$ BEGIN
  CREATE TYPE "booking"."AttendanceMethod" AS ENUM ('qr_scan', 'manual_override');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "attendedAt" TIMESTAMP(3);
ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "attendanceMethod" "booking"."AttendanceMethod";
ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "attendanceVerifiedBy" INTEGER;
ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "attendanceOverrideReason" TEXT;

CREATE INDEX IF NOT EXISTS "Booking_gymId_date_attendedAt_idx" ON "booking"."Booking"("gymId", "date", "attendedAt");
CREATE INDEX IF NOT EXISTS "Booking_attendedAt_idx" ON "booking"."Booking"("attendedAt");
