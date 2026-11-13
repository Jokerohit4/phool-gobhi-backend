BEGIN;
-- Existing personal routines and all historic sessions remain main-work entries.
ALTER TABLE "health"."TemplateExercise" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'main', ADD COLUMN "instructions" TEXT;
ALTER TABLE "health"."SessionExercise" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'main', ADD COLUMN "instructions" TEXT, ADD COLUMN "restSeconds" INTEGER;
ALTER TABLE "health"."TemplateExercise" ADD CONSTRAINT "TemplateExercise_phase_check" CHECK ("phase" IN ('warm_up', 'main', 'cool_down'));
ALTER TABLE "health"."SessionExercise" ADD CONSTRAINT "SessionExercise_phase_check" CHECK ("phase" IN ('warm_up', 'main', 'cool_down'));

-- Upgrade shared system routines only. Personal copies and session history stay intact.
-- Fail atomically when the prerequisite exercise catalogue has not been provisioned.
DO $$ BEGIN
  IF (SELECT COUNT(DISTINCT "name") FROM "health"."Exercise" WHERE "createdByUserId" IS NULL AND "name" IN ('March in Place', 'Cat-Cow', 'Chest Doorway Stretch', 'Hip Flexor Stretch', 'Standing Hamstring Stretch')) <> 5
  THEN RAISE EXCEPTION 'Routine preparation exercises missing: provision the exercise catalogue first'; END IF;
END $$;
UPDATE "health"."TemplateExercise" SET "order" = "order" + 2 WHERE "templateId" IN (SELECT "id" FROM "health"."WorkoutTemplate" WHERE "isSystem" = TRUE);
INSERT INTO "health"."TemplateExercise" ("templateId", "exerciseId", "order", "targetSets", "targetDurationSeconds", "restSeconds", "phase", "instructions")
SELECT t."id", e."id", v.position, v.sets, v.seconds, 0, v.phase, v.instructions
FROM "health"."WorkoutTemplate" t
CROSS JOIN (VALUES
 ('March in Place', 0, 1, 300, 'warm_up', 'Start gently and gradually increase your pace over 5 minutes.'),
 ('Cat-Cow', 1, 1, 60, 'warm_up', 'Move smoothly with your breath through a comfortable range.')
) AS v(name, position, sets, seconds, phase, instructions)
JOIN "health"."Exercise" e ON e."name" = v.name AND e."createdByUserId" IS NULL
WHERE t."isSystem" = TRUE;
INSERT INTO "health"."TemplateExercise" ("templateId", "exerciseId", "order", "targetSets", "targetDurationSeconds", "restSeconds", "phase", "instructions")
SELECT t."id", e."id", last_entry.position + v.position, v.sets, v.seconds, 0, 'cool_down', v.instructions
FROM "health"."WorkoutTemplate" t
JOIN LATERAL (SELECT COALESCE(MAX("order"), 0) AS position FROM "health"."TemplateExercise" WHERE "templateId" = t."id") last_entry ON TRUE
CROSS JOIN (VALUES
 ('March in Place', 1, 1, 300, 'Gradually slow your pace and let your breathing settle.'),
 ('Chest Doorway Stretch', 2, 2, 30, 'Hold gently for 30 seconds on each side, one side per set. Breathe normally; do not bounce or push into pain.'),
 ('Hip Flexor Stretch', 3, 2, 30, 'Hold gently for 30 seconds on each side, one side per set. Breathe normally; do not bounce or push into pain.'),
 ('Standing Hamstring Stretch', 4, 2, 30, 'Hold gently for 30 seconds on each side, one side per set. Breathe normally; do not bounce or push into pain.')
) AS v(name, position, sets, seconds, instructions)
JOIN "health"."Exercise" e ON e."name" = v.name AND e."createdByUserId" IS NULL
WHERE t."isSystem" = TRUE;
UPDATE "health"."WorkoutTemplate" SET "estMinutes" = "estMinutes" + 14, "description" = COALESCE("description", '') || ' Includes a 6-minute warm-up and 8-minute cool-down with stretching.' WHERE "isSystem" = TRUE;

COMMIT;
