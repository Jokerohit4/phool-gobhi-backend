-- CreateIndex (only if it doesn't exist)
CREATE INDEX IF NOT EXISTS "SavedAddress_userId_idx" ON "auth"."SavedAddress"("userId");

-- CreateTable (only if it doesn't exist) — persistent OTP store, replaces the
-- in-memory Map that didn't survive Cloud Run cold starts/multi-instance scaling
CREATE TABLE IF NOT EXISTS "auth"."OtpCode" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "OtpCode_phone_key" ON "auth"."OtpCode"("phone");
EXCEPTION
  WHEN duplicate_table THEN null;
END $$;
