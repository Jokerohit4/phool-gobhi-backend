-- Per-phone failed-OTP-attempt counter — lets verifyOtpService lock out a
-- phone's live code after repeated wrong guesses instead of allowing
-- unlimited attempts within its 5-minute window (previously bounded only by
-- the gateway's per-IP rate limit, not per-phone).
ALTER TABLE "auth"."OtpCode" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
