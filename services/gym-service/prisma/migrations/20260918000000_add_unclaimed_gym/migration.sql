-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Non-partner gyms (2026-09-18). A place a customer says they train at, which
-- we do not have a partnership with. Purely additive: no existing table or
-- column is touched, so this is a no-op for every current read path.

DO $$ BEGIN
  CREATE TYPE "gym"."ClaimStatus" AS ENUM ('unclaimed', 'claim_pending', 'claimed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "gym"."UnclaimedGym" (
    "id" SERIAL NOT NULL,
    "googlePlaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "addedByUserId" INTEGER NOT NULL,
    "claimStatus" "gym"."ClaimStatus" NOT NULL DEFAULT 'unclaimed',
    "claimedGymId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnclaimedGym_pkey" PRIMARY KEY ("id")
);

-- Unique on the Places id is what makes the upsert converge: two customers
-- naming the same gym produce one row, not two, which is the whole basis of
-- the "how many of our users train here" acquisition signal.
CREATE UNIQUE INDEX IF NOT EXISTS "UnclaimedGym_googlePlaceId_key"
  ON "gym"."UnclaimedGym"("googlePlaceId");

CREATE INDEX IF NOT EXISTS "UnclaimedGym_claimStatus_idx"
  ON "gym"."UnclaimedGym"("claimStatus");
