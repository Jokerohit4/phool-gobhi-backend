-- A sports user is their own persona rather than part of home_training.
-- No backfill: stored personas are untouched, and a null persona is resolved
-- from the onboarding answers on read (trainingLocationPref 'sports' now
-- resolves to sports).
ALTER TYPE "auth"."Persona" ADD VALUE IF NOT EXISTS 'sports';
