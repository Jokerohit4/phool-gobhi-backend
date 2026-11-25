-- Routine catalogue: system WorkoutTemplates become the single, backend-owned
-- source of starter routines (key, category, goal, publish flag, per-language
-- text), so the customer app stops bundling its own copy.
--
-- Additive only. Every new column is nullable or defaulted. The 16 existing
-- system routines get their stable key, category and goal here (by exact name,
-- the same names seedBeginnerTemplates.js and seedHomeTrack.js used), stay
-- legacy-listed so older app builds keep showing exactly what they showed
-- before, and get an English text row copied from their current name/description.
-- Their exercises are not touched.
SET lock_timeout = '3s';

ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "key" TEXT;
ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "goal" TEXT;
ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "isPublished" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "legacyListed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "health"."WorkoutTemplate" ADD COLUMN IF NOT EXISTS "updatedBy" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "WorkoutTemplate_key_key" ON "health"."WorkoutTemplate"("key");

CREATE TABLE IF NOT EXISTS "health"."WorkoutTemplateText" (
    "id" SERIAL NOT NULL,
    "templateId" INTEGER NOT NULL,
    "lang" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "guidance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkoutTemplateText_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkoutTemplateText_templateId_lang_key" ON "health"."WorkoutTemplateText"("templateId", "lang");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkoutTemplateText_templateId_fkey'
  ) THEN
    ALTER TABLE "health"."WorkoutTemplateText"
      ADD CONSTRAINT "WorkoutTemplateText_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "health"."WorkoutTemplate"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill the existing system routines. Only rows that have no key yet are
-- touched, so a re-run never overwrites a later edit.
UPDATE "health"."WorkoutTemplate" AS t
SET "key" = v.key, "category" = v.category, "goal" = v.goal, "legacyListed" = TRUE
FROM (VALUES
  ('Full Body x3 — Beginner-friendly', 'gym_starter_full_body_x3', 'full_body', 'muscleBuilding'),
  ('Push Day A', 'gym_starter_push_a', 'push', 'muscleBuilding'),
  ('Leg Day', 'gym_starter_legs', 'legs', 'muscleBuilding'),
  ('Upper & Abs', 'gym_starter_upper_abs', 'full_body', 'muscleBuilding'),
  ('Full body — no equipment', 'home_full_body_20', 'full_body', 'beginner'),
  ('Full body — 15 minute', 'home_full_body_15', 'full_body', 'beginner'),
  ('Push — bodyweight', 'home_push', 'push', 'beginner'),
  ('Pull — no bar', 'home_pull', 'pull', 'beginner'),
  ('Legs — bodyweight', 'home_legs', 'legs', 'beginner'),
  ('Core — 10 minute', 'home_core_10', 'core', 'beginner'),
  ('Low-impact cardio (no jumping)', 'home_cardio_low_impact', 'cardio', 'fatLoss'),
  ('Mobility & stretch', 'home_mobility', 'mobility', 'mobility'),
  ('Push — intermediate', 'home_push_intermediate', 'push', 'muscleBuilding'),
  ('Legs — intermediate', 'home_legs_intermediate', 'legs', 'muscleBuilding'),
  ('Full body — intermediate', 'home_full_body_intermediate', 'full_body', 'muscleBuilding'),
  ('Desk reset — 8 minute', 'home_desk_reset', 'mobility', 'mobility')
) AS v(name, key, category, goal)
WHERE t."isSystem" = TRUE AND t."name" = v.name AND t."key" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "health"."WorkoutTemplate" k WHERE k."key" = v.key);

-- English text for every system routine that has none yet.
INSERT INTO "health"."WorkoutTemplateText" ("templateId", "lang", "name", "description", "updatedAt")
SELECT t."id", 'en', t."name", t."description", CURRENT_TIMESTAMP
FROM "health"."WorkoutTemplate" t
WHERE t."isSystem" = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "health"."WorkoutTemplateText" x WHERE x."templateId" = t."id" AND x."lang" = 'en'
  );
