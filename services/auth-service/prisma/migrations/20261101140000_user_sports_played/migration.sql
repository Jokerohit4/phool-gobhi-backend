-- Sports the user plays (constants/sports.js). Plain text[] so the catalog can
-- grow with sports venues without an enum migration. Empty by default.
ALTER TABLE "auth"."User"
ADD COLUMN IF NOT EXISTS "sportsPlayed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
