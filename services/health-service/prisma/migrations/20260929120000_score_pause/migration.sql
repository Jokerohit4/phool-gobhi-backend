-- Gives the score an off-ramp, and marks the days it was used on.
--
-- Why this exists: the score is a running chain, so every day it is live it can
-- only move the total up or down. Someone who is ill, injured, travelling, or
-- simply in a bad stretch has no way to stop the decline, and the people most
-- likely to need a pause are exactly the ones a relentless daily number pushes
-- out of the app for good. The comeback nudge was aimed at this group, and it
-- could not have worked: it asked a user who was already losing points daily to
-- also respond to a push notification.
--
-- HealthGoal.pausedFrom/pausedUntil, both the user's local day string, the same
-- convention as BiometricEntry.localDate and WorkoutSession.localDate. Two
-- nullable columns rather than a Pause model, because a pause has no history
-- worth its own table - it is a window on the goal, and the one thing that
-- needs to survive (where the user left off) is on the row already.
--
-- The 14-day cap is NOT in this migration and NOT in the schema. It lives in
-- scoreService.setPause, in application code, because it is a product rule that
-- is expected to change, and a cap expressed only as a CHECK constraint would
-- be permanent. The service is the single enforcement point, so calling the
-- endpoint directly cannot buy a longer pause than the app offers.
--
-- ScoreDaySnapshot.paused marks days frozen inside a pause window. Default
-- FALSE, which is correct for every pre-existing row: none of them were paused,
-- because pausing did not exist when they were written.
--
-- A paused day is written as a flat snapshot (open == high == low == close) with
-- an empty breakdown, not omitted. Two reasons. The chain stays contiguous, so
-- the first real day after a pause resumes from the close the user last earned
-- rather than from a stale value. And the flat day stays VISIBLE in the series,
-- so a stretch that did not move is explained by a pause instead of looking
-- like the app silently lost the user's history.
--
-- IF NOT EXISTS on all three, matching the consent-scope migration, so this is
-- re-runnable against a database that was partially applied.
ALTER TABLE "health"."HealthGoal"
  ADD COLUMN IF NOT EXISTS "pausedFrom" TEXT,
  ADD COLUMN IF NOT EXISTS "pausedUntil" TEXT;

ALTER TABLE "health"."ScoreDaySnapshot"
  ADD COLUMN IF NOT EXISTS "paused" BOOLEAN NOT NULL DEFAULT FALSE;
