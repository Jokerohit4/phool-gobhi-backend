-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations.
--
-- Session reminders (2026-10-08). The hourly sweep pushes "your session starts
-- soon" to customers with a confirmed booking starting in the next 1-2 hours,
-- and stamps this column when it claims the booking so no booking is reminded
-- twice. Purely additive: one nullable column, no index (the sweep's query is
-- bounded by status + date and already served by existing indexes).

ALTER TABLE "booking"."Booking"
  ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);
