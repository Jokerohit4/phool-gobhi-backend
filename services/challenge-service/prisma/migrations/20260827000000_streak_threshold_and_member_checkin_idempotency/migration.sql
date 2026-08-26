-- qualifyingCheckinsPerWeek moves from a hardcoded constant in
-- streakService.js to an admin-editable column, defaulting to the same
-- value (2) the constant used.
ALTER TABLE "challenge"."CoinEconomyConfig" ADD COLUMN "qualifyingCheckinsPerWeek" INTEGER NOT NULL DEFAULT 2;

-- AttendanceEventLog's idempotency moves from bookingId (NOT NULL UNIQUE)
-- to a caller-derived idempotencyKey, since a booking-free attendance-SaaS
-- member check-in (source 'member_checkin') has no bookingId to key off.
-- This table has never been deployed with real data (this service had zero
-- migrations before this branch), so this is a direct, backfill-free change.
DROP INDEX "challenge"."AttendanceEventLog_bookingId_key";

ALTER TABLE "challenge"."AttendanceEventLog"
  ALTER COLUMN "bookingId" DROP NOT NULL,
  ADD COLUMN "memberAttendanceId" INTEGER,
  ADD COLUMN "idempotencyKey" TEXT NOT NULL;

CREATE UNIQUE INDEX "AttendanceEventLog_idempotencyKey_key" ON "challenge"."AttendanceEventLog"("idempotencyKey");
