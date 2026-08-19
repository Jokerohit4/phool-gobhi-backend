-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Attendance-SaaS wedge: per-gym honeymoon start date + an override for the
-- post-honeymoon subscription commission rate, decoupled from the existing
-- commissionPct (which keeps governing one-off marketplace bookings).
--
-- Backfill: any gym already approved before this migration runs gets
-- partnershipStartDate = createdAt, i.e. its honeymoon is already over — an
-- already-live gym should not retroactively get a fresh free month it never
-- had. Not-yet-approved gyms are left NULL; approveGym() sets the real value
-- the moment a gobhi approves them.

ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "partnershipStartDate" TIMESTAMP(3);
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "subscriptionCommissionPct" NUMERIC(5,2);

UPDATE "gym"."Gym" SET "partnershipStartDate" = "createdAt" WHERE "isApproved" = true AND "partnershipStartDate" IS NULL;
