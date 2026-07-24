-- AlterTable (only add columns if they don't exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'JobApplication' AND column_name = 'phone') THEN
    ALTER TABLE "auth"."JobApplication" ADD COLUMN "phone" TEXT;
    UPDATE "auth"."JobApplication" SET "phone" = '' WHERE "phone" IS NULL;
    ALTER TABLE "auth"."JobApplication" ALTER COLUMN "phone" SET NOT NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'JobApplication' AND column_name = 'portfolioUrl') THEN
    ALTER TABLE "auth"."JobApplication" ADD COLUMN "portfolioUrl" TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'JobApplication' AND column_name = 'linkedinUrl') THEN
    ALTER TABLE "auth"."JobApplication" ADD COLUMN "linkedinUrl" TEXT;
  END IF;
END $$;
