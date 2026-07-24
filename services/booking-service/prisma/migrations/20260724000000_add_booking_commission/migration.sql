-- Hand-authored migration (no DATABASE_URL/shadow DB available). Same caveat
-- as the preceding migrations: reconcile against the actual dev/prod DB
-- before applying.
--
-- Adds commissionPct/partnerShare to Booking, mirroring
-- GymSubscription.commissionPct/partnerShare in wallet-service (Decimal, same
-- as that model — this migration was never deployed anywhere before the
-- Float->Decimal pass, so declaring it Decimal from the start here avoids a
-- pointless follow-up ALTER). Nullable: existing rows (and
-- subscription-covered bookings going forward) have no value here, and
-- completeBooking falls back to the full amount when null.

ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "commissionPct" NUMERIC(5,2);
ALTER TABLE "booking"."Booking" ADD COLUMN IF NOT EXISTS "partnerShare" NUMERIC(19,2);
