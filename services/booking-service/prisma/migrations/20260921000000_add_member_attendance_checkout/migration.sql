-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying -- same caveat as the preceding migrations.
--
-- Member check-out (2026-09-21). Linked members can now tap "check out" on
-- the work-out home and record when they left, complementing memberCheckIn.
-- Purely additive: a new nullable column on MemberAttendance, no existing
-- table or index is touched. One check-in per customer+gym+day is preserved
-- by the existing unique constraint -- a same-day re-entry after checking out
-- re-nulls this column in place (bookingService.memberCheckIn), it never
-- creates a second row.

ALTER TABLE "booking"."MemberAttendance"
  ADD COLUMN "checkedOutAt" TIMESTAMP(3);