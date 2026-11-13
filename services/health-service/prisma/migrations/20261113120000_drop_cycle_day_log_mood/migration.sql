-- Mood is stored once, in WellnessMoodCheckIn. CycleDayLog keeps flow and
-- symptoms only. The column was added hours earlier in
-- 20261113000000_add_cycle_day_log and was never shipped beyond dev.
ALTER TABLE "health"."CycleDayLog" DROP COLUMN IF EXISTS "mood";
