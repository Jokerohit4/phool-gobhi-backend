-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Same caveat as the preceding
-- migrations: reconcile against the actual dev/prod DB before applying.
--
-- OtpProviderSetting: singleton config row read by public GET
-- /api/auth/otp-config, admin-editable via GET/PUT /api/auth/otp-config/admin.
-- No row means the legacy OTP_PROVIDER env var (falling back to "fast2sms")
-- still applies until an admin explicitly sets one.
--
-- OtpSkipAllowlistEntry: phone numbers allowed to bypass real OTP with
-- 123456 while OtpProviderSetting.provider = 'skip'. Empty table means skip
-- mode bypasses nothing for anyone.

CREATE TABLE IF NOT EXISTS "auth"."OtpProviderSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL DEFAULT 'fast2sms',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,

    CONSTRAINT "OtpProviderSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "auth"."OtpSkipAllowlistEntry" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpSkipAllowlistEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OtpSkipAllowlistEntry_phone_key" ON "auth"."OtpSkipAllowlistEntry"("phone");
