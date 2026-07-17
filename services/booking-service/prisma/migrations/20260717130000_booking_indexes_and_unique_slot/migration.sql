-- Hand-authored migration (no DATABASE_URL/shadow DB was available in this
-- environment to run `prisma migrate dev`). This service has never had a
-- prisma/migrations directory at all — its schema was very likely applied
-- via `prisma db push` up to now. Before applying this, reconcile against
-- the actual dev/prod DB (e.g. `prisma migrate diff` against it, or
-- `prisma migrate resolve --applied` for the gap) rather than trusting this
-- file blindly — it was authored from schema.prisma only, not verified
-- against a live database.

-- CreateIndex: Booking had no indexes at all; every capacity check, sales
-- summary, and slot-count query filters by these columns.
CREATE INDEX "Booking_gymId_date_idx" ON "booking"."Booking"("gymId", "date");
CREATE INDEX "Booking_customerId_idx" ON "booking"."Booking"("customerId");

-- CreateIndex: partial unique index — backstops createBooking's app-level
-- duplicate-slot check against a double-tap/retry race. Deliberately
-- excludes cancelled bookings (WHERE status <> 'cancelled') so a customer
-- can still re-book a slot after cancelling an earlier booking for it.
-- Prisma's schema.prisma has no syntax for a filtered/partial unique index,
-- so this exists only here — `prisma db push`/introspection will not see it
-- and may report drift; do not let a `db push` silently drop it.
CREATE UNIQUE INDEX "booking_unique_active_slot"
  ON "booking"."Booking" ("customerId", "gymId", "date", "startTime")
  WHERE "status" <> 'cancelled';
