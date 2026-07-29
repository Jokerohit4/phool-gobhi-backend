-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment). Same caveat as preceding migrations: reconcile against the
-- actual dev/prod DB before applying.
--
-- Adds a 'started' BookingStatus value — set by verifyAttendance/selfCheckIn
-- once attendance is verified, so a booking reads as "in progress" instead
-- of still "confirmed" (not yet arrived) between check-in and completion.
-- ALTER TYPE ... ADD VALUE must run outside a transaction block in older
-- Postgres versions — kept as its own statement, same as prior additions.
ALTER TYPE "booking"."BookingStatus" ADD VALUE IF NOT EXISTS 'started';
