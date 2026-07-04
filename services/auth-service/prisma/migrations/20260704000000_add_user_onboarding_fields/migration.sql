-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "auth"."Gender" AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "auth"."FitnessGoal" AS ENUM ('weight_loss', 'muscle_gain', 'general_fitness', 'flexibility_yoga', 'sports_training', 'rehabilitation');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable (only add columns if they don't exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'User' AND column_name = 'gender') THEN
    ALTER TABLE "auth"."User" ADD COLUMN "gender" "auth"."Gender";
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'User' AND column_name = 'dateOfBirth') THEN
    ALTER TABLE "auth"."User" ADD COLUMN "dateOfBirth" DATE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'User' AND column_name = 'fitnessGoals') THEN
    ALTER TABLE "auth"."User" ADD COLUMN "fitnessGoals" "auth"."FitnessGoal"[] NOT NULL DEFAULT ARRAY[]::"auth"."FitnessGoal"[];
  END IF;
END $$;
