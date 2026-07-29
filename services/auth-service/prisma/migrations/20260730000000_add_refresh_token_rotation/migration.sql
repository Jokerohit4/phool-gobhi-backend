-- CreateTable (only if it doesn't exist) — refresh-token rotation store.
-- Replaces the fully stateless refresh JWT (signature-only, no revocation)
-- with a DB-backed chain so a used token can be rotated and, on replay
-- outside the grace window, the whole family revoked.
CREATE TABLE IF NOT EXISTS "auth"."RefreshToken" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "replacedByJti" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "RefreshToken_jti_key" ON "auth"."RefreshToken"("jti");
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "RefreshToken_familyId_idx" ON "auth"."RefreshToken"("familyId");
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "auth"."RefreshToken"("userId");

DO $$ BEGIN
  ALTER TABLE "auth"."RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
