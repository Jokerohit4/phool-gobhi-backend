-- A week in which the user switched persona does not break their streak
-- (streakService.applyPersonaSwitchGrace / closeWeek).
ALTER TABLE "challenge"."UserStreakWeek"
ADD COLUMN "graceWeek" BOOLEAN NOT NULL DEFAULT false;
