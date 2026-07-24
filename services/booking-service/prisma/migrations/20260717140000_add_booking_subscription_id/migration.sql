-- Hand-authored migration (no DATABASE_URL/shadow DB available). Same caveat
-- as the preceding migration: reconcile against the actual dev/prod DB
-- before applying.
--
-- schema.prisma already declares Booking.subscriptionId (added for the gym-
-- subscriptions feature — see wallet-service's GymSubscription model) but no
-- migration existed to create the column, which would break every Prisma
-- query against Booking until this runs.

ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "subscriptionId" INTEGER;
