-- Explicit, server-owned persona (services/personaService.js).
--
-- No backfill: a null persona is resolved from the onboarding answers on read,
-- exactly as before, so every existing account keeps its current experience
-- until it switches or its gym link changes.
CREATE TYPE "auth"."Persona" AS ENUM ('linked_gym', 'own_gym', 'wellness', 'home_training', 'explorer');

ALTER TABLE "auth"."User"
ADD COLUMN "persona" "auth"."Persona";

ALTER TABLE "auth"."AppModeHistory"
ADD COLUMN "fromPersona" "auth"."Persona",
ADD COLUMN "toPersona" "auth"."Persona";

-- One active GymLink per user. linkGym read User.linkedGymId without a lock,
-- so a login backfill racing a profile save could create two active links
-- (two rosters, two bills). Close the duplicates first so the index can be
-- built on existing data: keep the link User.linkedGymId points at (the app
-- and the bill both follow the pointer), then the newest of any remaining.
UPDATE "auth"."GymLink" AS g
SET "removedAt" = NOW()
FROM "auth"."User" AS u
WHERE g."removedAt" IS NULL
  AND u."id" = g."userId"
  AND u."linkedGymId" IS NOT NULL
  AND g."gymId" <> u."linkedGymId"
  AND EXISTS (
    SELECT 1 FROM "auth"."GymLink" AS kept
    WHERE kept."userId" = g."userId"
      AND kept."removedAt" IS NULL
      AND kept."gymId" = u."linkedGymId"
  );

UPDATE "auth"."GymLink" AS g
SET "removedAt" = NOW()
WHERE g."removedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "auth"."GymLink" AS newer
    WHERE newer."userId" = g."userId"
      AND newer."removedAt" IS NULL
      AND (newer."linkedAt" > g."linkedAt"
        OR (newer."linkedAt" = g."linkedAt" AND newer."id" > g."id"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "GymLink_userId_active_key"
  ON "auth"."GymLink"("userId")
  WHERE "removedAt" IS NULL;
