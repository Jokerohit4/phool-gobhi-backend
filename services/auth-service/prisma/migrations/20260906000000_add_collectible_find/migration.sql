-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Map collectibles (veggie pickups): a standalone currency, not coins, not
-- tied to gyms/bookings. Spawn points are deterministic client-side (fixed
-- grid) -- this table only records which ones a user has found.

CREATE TABLE IF NOT EXISTS "auth"."CollectibleFind" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "collectibleId" TEXT NOT NULL,
    "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectibleFind_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CollectibleFind_userId_collectibleId_key"
    ON "auth"."CollectibleFind"("userId", "collectibleId");

ALTER TABLE "auth"."CollectibleFind"
    ADD CONSTRAINT "CollectibleFind_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "auth"."User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
