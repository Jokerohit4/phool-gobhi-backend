-- Hand-authored migration (same caveat as every prior migration in this
-- service: no shadow DB was available to run `prisma migrate dev`;
-- reconcile against the actual dev/prod DB before applying).
--
-- Adds classId to Booking (recurring-class bookings alongside plain session
-- bookings — see gym-service's GymClass) plus two changes to existing
-- indexes needed to keep the two booking kinds from colliding.
--
-- NOTE on CONCURRENTLY: `CREATE INDEX CONCURRENTLY` would be the safer
-- choice on a live table (no lock while building), but it cannot run inside
-- a transaction block, and `prisma migrate deploy` always wraps a migration
-- file in one — this repo has no separate mechanism for running
-- non-transactional migrations, and no prior migration here uses
-- CONCURRENTLY either. Given the Booking table's actual size at this stage
-- of the platform's launch (a handful of onboarded gyms), a plain
-- CREATE/DROP INDEX locks for a negligible amount of time. Deliberate
-- tradeoff, not an oversight — revisit if this table grows large enough for
-- the lock duration to matter.

ALTER TABLE "booking"."Booking" ADD COLUMN "classId" INTEGER;

-- Lets the capacity count inside reserveBookingSlot's Serializable
-- transaction (bookingService.js) satisfy its predicate via an index scan
-- instead of a seq scan — without this, SIREAD locking degrades to
-- page/relation granularity under load, causing spurious serialization
-- conflicts for unrelated concurrent bookings as the table grows.
CREATE INDEX "Booking_classId_date_idx" ON "booking"."Booking"("classId", "date");

-- Replace booking_unique_active_slot with a version scoped to plain-slot
-- bookings only (classId IS NULL). Without this fix, a class booking whose
-- startTime happens to coincide with a walk-in slot's startTime would
-- wrongly collide with that customer's regular-slot uniqueness check under
-- the old, class-unaware index and be rejected as a false duplicate.
DROP INDEX IF EXISTS "booking"."booking_unique_active_slot";

DO $$ BEGIN
  CREATE UNIQUE INDEX "booking_unique_active_slot"
    ON "booking"."Booking" ("customerId", "gymId", "date", "startTime")
    WHERE "status" <> 'cancelled' AND "classId" IS NULL;
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;

-- New: prevents double-booking the same class occurrence (mirrors the
-- plain-slot index above, scoped the other way).
DO $$ BEGIN
  CREATE UNIQUE INDEX "booking_unique_active_class_occurrence"
    ON "booking"."Booking" ("customerId", "classId", "date")
    WHERE "classId" IS NOT NULL AND "status" <> 'cancelled';
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;
