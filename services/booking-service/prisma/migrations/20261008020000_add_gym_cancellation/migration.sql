-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations.
--
-- Gym-side cancellation (2026-10-08). Until now only the customer could cancel;
-- a gym that had to close had no way to refund anyone. cancelledByGymAt marks a
-- cancellation the gym made (the customer's own cancellationReason enum is a
-- customer survey answer and stays untouched), and gymCancelReason carries the
-- short note the gym gives, which is shown to the customer. Purely additive.

ALTER TABLE "booking"."Booking"
  ADD COLUMN IF NOT EXISTS "cancelledByGymAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "gymCancelReason" TEXT;
