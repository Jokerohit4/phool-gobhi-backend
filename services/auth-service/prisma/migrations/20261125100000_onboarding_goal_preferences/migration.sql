ALTER TABLE "auth"."User" ADD COLUMN "goalPreferences" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
