-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Platform-wide reviews ("What users say about us"), one row per customer,
-- read publicly (approved only) via GET /api/auth/platform-reviews and
-- moderated via /api/auth/admin/platform-reviews.

CREATE TABLE IF NOT EXISTS "auth"."PlatformReview" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformReview_customerId_key" ON "auth"."PlatformReview"("customerId");
