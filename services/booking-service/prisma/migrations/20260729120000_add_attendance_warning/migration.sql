-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment). Same caveat as preceding migrations: reconcile against the
-- actual dev/prod DB before applying.
--
-- 1. partner-web's manual "Verify attendance" path has been writing
--    attendanceMethod: 'manual_verify' since it was added, but no enum value
--    for it ever existed — every real manual verification throws a Prisma
--    invalid-enum-value error. ALTER TYPE ... ADD VALUE must run outside a
--    transaction block in older Postgres versions — kept as its own
--    statement, same as prior AttendanceMethod additions.
ALTER TYPE "booking"."AttendanceMethod" ADD VALUE IF NOT EXISTS 'manual_verify';

-- 2. Marks a booking whose startTime/endTime were shifted because a partner
--    scanned its QR before the session window opened and chose to proceed.
--    Customer-facing only.
ALTER TABLE "booking"."Booking" ADD COLUMN "slotShiftWarning" BOOLEAN NOT NULL DEFAULT false;

-- 3. One row per early-scan confirmation — the customer's warning log.
CREATE TABLE "booking"."AttendanceWarning" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "gymId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "originalStartTime" TEXT NOT NULL,
    "originalEndTime" TEXT NOT NULL,
    "newStartTime" TEXT NOT NULL,
    "newEndTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceWarning_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttendanceWarning_customerId_idx" ON "booking"."AttendanceWarning"("customerId");
CREATE INDEX "AttendanceWarning_bookingId_idx" ON "booking"."AttendanceWarning"("bookingId");
