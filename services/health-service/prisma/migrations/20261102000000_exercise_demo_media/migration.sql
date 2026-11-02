-- Demo animation + attribution for catalogue exercises. Additive, nullable.
ALTER TABLE "health"."Exercise" ADD COLUMN IF NOT EXISTS "demoGifUrl" TEXT;
ALTER TABLE "health"."Exercise" ADD COLUMN IF NOT EXISTS "mediaAttribution" TEXT;
