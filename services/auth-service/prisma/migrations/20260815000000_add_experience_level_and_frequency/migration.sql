-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "auth"."ExperienceLevel" AS ENUM ('new_to_gym', 'restarting_after_break', 'experienced');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "auth"."FrequencyIntent" AS ENUM ('one_two', 'three_four', 'five_plus');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable (only add columns if they don't exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'User' AND column_name = 'experienceLevel') THEN
    ALTER TABLE "auth"."User" ADD COLUMN "experienceLevel" "auth"."ExperienceLevel";
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'User' AND column_name = 'weeklyFrequencyIntent') THEN
    ALTER TABLE "auth"."User" ADD COLUMN "weeklyFrequencyIntent" "auth"."FrequencyIntent";
  END IF;
END $$;
