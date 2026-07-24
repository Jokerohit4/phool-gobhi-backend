-- AlterTable (only add the column if it doesn't exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'JobApplication' AND column_name = 'resumeUrl') THEN
    ALTER TABLE "auth"."JobApplication" ADD COLUMN "resumeUrl" TEXT;
  END IF;
END $$;
