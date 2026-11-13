-- Attendance provenance on WorkoutSession: how a gym visit was proven, and when
-- the gym recorded it, copied from booking-service when it posts the attendance
-- event that drafts the session.
--
-- Why it is snapshotted here rather than looked up: the insurer-grade score
-- (services/share/insurerGrade.js) needs to label every visit with its evidence
-- level, and a cross-service call per session at read time is both slow and a
-- second source of truth that can change after the fact. Snapshot-at-event-time
-- is already the house style (FoodLog nutrients, HealthGoal sex/age).
--
-- attendanceMethod is TEXT, not an enum. It mirrors booking-service's
-- AttendanceMethod values, and a copied enum would break the day booking adds a
-- value; the service keeps an allowlist and stores null for anything it does not
-- recognise.
--
-- Both columns are nullable and there is NO backfill. Existing rows keep null,
-- which the score reads as "unknown provenance" - a visit we cannot prove is
-- never retroactively promoted to a verified one.
--
-- IF NOT EXISTS, matching the other additive health migrations, so this is
-- re-runnable against a partially applied database.
ALTER TABLE "health"."WorkoutSession"
  ADD COLUMN IF NOT EXISTS "attendedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attendanceMethod" TEXT;
