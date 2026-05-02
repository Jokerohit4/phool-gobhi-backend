/*
  Warnings:

  - Added the required column `name` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `role` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('customer', 'partner', 'gobhi');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "UserType" AS ENUM ('general', 'sub_premium', 'premium');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if they don't exist)
DO $$ BEGIN
  CREATE TYPE "GobhiType" AS ENUM ('trainer', 'cleaner', 'manager');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable (only add columns if they don't exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'name') THEN
    ALTER TABLE "User" ADD COLUMN "name" TEXT;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'role') THEN
    ALTER TABLE "User" ADD COLUMN "role" "Role";
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'type') THEN
    ALTER TABLE "User" ADD COLUMN "type" "UserType";
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'gobhiType') THEN
    ALTER TABLE "User" ADD COLUMN "gobhiType" "GobhiType";
  END IF;
END $$;

-- Make columns NOT NULL if they are NULL (for existing rows, set default values first)
DO $$ 
BEGIN
  -- Set default values for any NULL values
  UPDATE "User" SET "name" = 'User' WHERE "name" IS NULL;
  UPDATE "User" SET "role" = 'customer'::"Role" WHERE "role" IS NULL;
  UPDATE "User" SET "type" = 'general'::"UserType" WHERE "type" IS NULL;
  
  -- Now make them NOT NULL
  ALTER TABLE "User" ALTER COLUMN "name" SET NOT NULL;
  ALTER TABLE "User" ALTER COLUMN "role" SET NOT NULL;
  ALTER TABLE "User" ALTER COLUMN "type" SET NOT NULL;
EXCEPTION
  WHEN OTHERS THEN null;
END $$;
