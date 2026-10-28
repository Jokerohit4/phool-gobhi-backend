ALTER TYPE "challenge"."ChallengeCategory" ADD VALUE IF NOT EXISTS 'personal_habit';
ALTER TYPE "challenge"."ChallengeType" ADD VALUE IF NOT EXISTS 'water_consistency';
ALTER TYPE "challenge"."ChallengeType" ADD VALUE IF NOT EXISTS 'mood_consistency';
ALTER TYPE "challenge"."ChallengeType" ADD VALUE IF NOT EXISTS 'workout_consistency';
ALTER TYPE "challenge"."VerificationMethod" ADD VALUE IF NOT EXISTS 'activity_log';
ALTER TABLE "challenge"."ChallengeDefinition" ADD COLUMN "audiences" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
