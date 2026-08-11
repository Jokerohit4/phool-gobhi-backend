-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations: reconcile against the actual dev/prod DB before applying.
--
-- ProfileCompletionBonusSetting: singleton config row for the one-time ₹
-- wallet bonus credited when a customer's profile crosses from incomplete
-- to complete. No row means the DEFAULT_PROFILE_COMPLETION_BONUS (20)
-- applies until an admin explicitly sets one via PUT
-- /api/auth/profile-completion-bonus/admin.

CREATE TABLE IF NOT EXISTS "auth"."ProfileCompletionBonusSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "amount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "ProfileCompletionBonusSetting_pkey" PRIMARY KEY ("id")
);
