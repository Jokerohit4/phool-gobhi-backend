-- AlterTable (only rename if the old column exists and the new one doesn't
-- yet) — resumes moved from Cloudinary (a stored URL) to GCS (a stored
-- object path, with a signed URL generated fresh on every admin read).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'JobApplication' AND column_name = 'resumeUrl')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'JobApplication' AND column_name = 'resumePath') THEN
    ALTER TABLE "auth"."JobApplication" RENAME COLUMN "resumeUrl" TO "resumePath";
  END IF;
END $$;
