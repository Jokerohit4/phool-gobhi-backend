-- Attendance leaderboards flip from opt-in to opt-out: everyone is visible
-- on boards unless they turn it off from the customer app's profile screen.

ALTER TABLE "auth"."User" ALTER COLUMN "leaderboardOptIn" SET DEFAULT true;

UPDATE "auth"."User" SET "leaderboardOptIn" = true;