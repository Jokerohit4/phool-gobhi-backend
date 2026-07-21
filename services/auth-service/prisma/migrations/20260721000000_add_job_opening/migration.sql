-- CreateEnum (only if it doesn't exist)
DO $$ BEGIN
  CREATE TYPE "auth"."EmploymentType" AS ENUM ('full_time', 'part_time', 'internship', 'contract');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable (only if it doesn't exist) — /careers job listings, managed by
-- staff via the admin portal's Jobs page.
CREATE TABLE IF NOT EXISTS "auth"."JobOpening" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "employmentType" "auth"."EmploymentType" NOT NULL,
    "description" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobOpening_pkey" PRIMARY KEY ("id")
);
