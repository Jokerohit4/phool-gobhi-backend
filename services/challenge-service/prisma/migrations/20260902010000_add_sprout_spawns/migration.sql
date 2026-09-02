-- Wave 2 — Explore Map redesign: server-authoritative wild Sprout spawns,
-- the first reward surface in this schema whose state can't be derived from
-- an existing table the way badges/attendance are (a catch pays real coins,
-- so the spawn's existence/expiry/catcher has to live somewhere the client
-- can't fake). See sprint2/explore-map-wave2-pokemongo-redesign-spec.html
-- §12-13. Species catalog stays a static list in sproutSpawnService.js, not
-- a table — same reasoning Wave 1 used to avoid a Badge table.
CREATE TYPE "challenge"."SproutRarity" AS ENUM ('common', 'uncommon', 'rare', 'legendary');

-- CreateTable
CREATE TABLE "challenge"."SproutSpawn" (
    "id" SERIAL NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "speciesKey" TEXT NOT NULL,
    "rarity" "challenge"."SproutRarity" NOT NULL,
    "coinValue" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "caughtByUserId" INTEGER,
    "caughtAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SproutSpawn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SproutSpawn_challengeId_expiresAt_idx" ON "challenge"."SproutSpawn"("challengeId", "expiresAt");

-- AddForeignKey
ALTER TABLE "challenge"."SproutSpawn" ADD CONSTRAINT "SproutSpawn_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "challenge"."Challenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
