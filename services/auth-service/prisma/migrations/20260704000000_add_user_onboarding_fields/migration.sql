-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "FitnessGoal" AS ENUM ('weight_loss', 'muscle_gain', 'general_fitness', 'flexibility_yoga', 'sports_training', 'rehabilitation');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable (only add columns if they don't exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'gender') THEN
    ALTER TABLE "User" ADD COLUMN "gender" "Gender";
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'dateOfBirth') THEN
    ALTER TABLE "User" ADD COLUMN "dateOfBirth" DATE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'fitnessGoals') THEN
    ALTER TABLE "User" ADD COLUMN "fitnessGoals" "FitnessGoal"[] NOT NULL DEFAULT ARRAY[]::"FitnessGoal"[];
  END IF;
END $$;
