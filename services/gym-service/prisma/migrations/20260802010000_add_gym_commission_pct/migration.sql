-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Per-gym platform commission, admin-editable via
-- PUT /api/gyms/:id/commission (gobhi-only), read by booking-service and
-- wallet-service when snapshotting a booking/subscription's commissionPct.
-- Defaults every existing + new gym to 20 so nothing changes until an admin
-- deliberately overrides a specific gym's rate.

ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "commissionPct" NUMERIC(5,2) NOT NULL DEFAULT 20;
