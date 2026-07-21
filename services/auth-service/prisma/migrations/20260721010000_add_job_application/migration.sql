-- CreateTable (only if it doesn't exist) — applications submitted against a
-- JobOpening from the website's /careers page. jobOpeningId/jobTitle are a
-- plain snapshot, not a foreign key, so a row survives the listing being
-- closed or deleted later.
CREATE TABLE IF NOT EXISTS "auth"."JobApplication" (
    "id" SERIAL NOT NULL,
    "jobOpeningId" INTEGER NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);
