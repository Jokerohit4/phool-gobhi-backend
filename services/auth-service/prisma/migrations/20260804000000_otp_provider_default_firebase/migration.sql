-- Hand-authored migration (same caveat as the preceding ones: no
-- DATABASE_URL/shadow DB in this environment to run `prisma migrate dev`).
--
-- Flip the OtpProviderSetting.provider column default from 'fast2sms' to
-- 'firebase' so a freshly migrated DB (no row yet) defaults to Firebase,
-- matching the code change that removed the legacy OTP_PROVIDER env fallback.
-- Existing rows are untouched — an admin-selected provider still wins.

ALTER TABLE "auth"."OtpProviderSetting" ALTER COLUMN "provider" SET DEFAULT 'firebase';
