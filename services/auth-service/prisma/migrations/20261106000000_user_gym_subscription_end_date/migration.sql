-- When the user's own-gym membership ends. Collected in onboarding; always a
-- future date at write time. Nullable: only own-gym members have one.
ALTER TABLE "auth"."User"
ADD COLUMN IF NOT EXISTS "gymSubscriptionEndDate" TIMESTAMP(3);
