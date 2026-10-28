UPDATE "auth"."User"
SET "appMode" = 'wellness'
WHERE "workoutIntent" = 'wellness_only'
   OR "wellnessSetupCompleted" = true
   OR cardinality("wellnessFocuses") > 0;
