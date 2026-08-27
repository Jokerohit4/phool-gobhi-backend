-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Defaults false for every existing row (including existing subscription-
-- linked bookings) — their payouts already happened under the old
-- unconditional wallet-credit behavior, so this must not retroactively
-- reroute anything already paid.

ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "isAttendanceSaas" BOOLEAN NOT NULL DEFAULT false;
