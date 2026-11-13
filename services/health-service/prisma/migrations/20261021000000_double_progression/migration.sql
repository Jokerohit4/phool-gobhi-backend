-- Double progression on routines: a rep range and a stored working weight per
-- template exercise. Additive and nullable: existing rows keep working as plain
-- sets x reps and simply never progress, which is what they did before.
SET lock_timeout = '3s';

ALTER TABLE "health"."TemplateExercise" ADD COLUMN IF NOT EXISTS "repMin" INTEGER;
ALTER TABLE "health"."TemplateExercise" ADD COLUMN IF NOT EXISTS "repMax" INTEGER;
ALTER TABLE "health"."TemplateExercise" ADD COLUMN IF NOT EXISTS "targetWeightKg" DOUBLE PRECISION;
