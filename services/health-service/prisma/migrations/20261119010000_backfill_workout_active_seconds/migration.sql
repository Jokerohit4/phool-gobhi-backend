-- Give legacy timed workouts the same duration fallback as the application.
UPDATE "health"."WorkoutSession" AS session
SET "activeSeconds" = LEAST(
    2147483647,
    FLOOR(EXTRACT(EPOCH FROM (session."endedAt" - session."startedAt")))
      - COALESCE(session."pausedSeconds", 0)
  )::integer
WHERE session."activeSeconds" IS NULL
  AND EXTRACT(EPOCH FROM (session."endedAt" - session."startedAt"))
        - COALESCE(session."pausedSeconds", 0) >= 600
  AND session."type" IS NOT NULL
  AND session."type" <> 'rest'
  AND NOT EXISTS (
    SELECT 1
    FROM "health"."SessionExercise" AS exercise
    JOIN "health"."WorkoutSet" AS workout_set
      ON workout_set."sessionExerciseId" = exercise."id"
    WHERE exercise."sessionId" = session."id"
  );
