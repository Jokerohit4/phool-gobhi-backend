-- Every Challenge instance gets a geographic anchor (city center for
-- gym-native challenges, checkpoint-cluster centroid for city quests) so the
-- 20km discovery/enrollment radius (services/location.js) can be enforced
-- server-side. Nullable: pre-existing rows are backfilled by
-- challengeCatalogService's idempotent seed on next boot; a challenge with
-- NULL coordinates is never shown or joinable.
ALTER TABLE "challenge"."Challenge" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "challenge"."Challenge" ADD COLUMN "lng" DOUBLE PRECISION;