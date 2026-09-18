-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Non-partner gym check-ins (2026-09-18). Purely additive; no existing table
-- or index is touched.
--
-- No lat/lng column on purpose: the GPS fix is verified against the gym's
-- geofence at write time and discarded. Storing it would put a person's
-- location history in the one service the DPDPA erasure fan-out deliberately
-- skips (auth-service/utils/eraseAcrossServices.js), and that skip is only
-- defensible while booking-service genuinely holds no PII.

CREATE TABLE IF NOT EXISTS "booking"."IndependentCheckIn" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "unclaimedGymId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndependentCheckIn_pkey" PRIMARY KEY ("id")
);

-- One check-in per person per gym per day. This IS the dedupe: it can't be
-- delegated to challenge-service's idempotencyKey, because that ingest route
-- sits behind the streaksCoins feature flag and rejects everything while the
-- flag is off — which would leave this endpoint with no dedupe at all in
-- exactly the configuration it first ships in.
CREATE UNIQUE INDEX IF NOT EXISTS "IndependentCheckIn_customerId_unclaimedGymId_date_key"
  ON "booking"."IndependentCheckIn"("customerId", "unclaimedGymId", "date");

CREATE INDEX IF NOT EXISTS "IndependentCheckIn_customerId_checkedInAt_idx"
  ON "booking"."IndependentCheckIn"("customerId", "checkedInAt");
