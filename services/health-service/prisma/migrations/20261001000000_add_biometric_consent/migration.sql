-- Consent to store body numbers a person types in by hand (weight, body fat,
-- and the Health+ quick-add metrics).
--
-- A new table rather than another entry on HealthConsent.scopes. Every scope on
-- that array hangs off the DEVICE-access grant (HealthConsent has a required
-- platform column and exists to gate the HealthKit / Health Connect prompt), so
-- adding manual entry there would mean a person has to connect Apple Health
-- before they are allowed to type their own weight. Manual entry and device
-- access are different decisions and get different rows.
--
-- Mirrors AssistantConsent column for column: the policy version is stamped by
-- the server, and a revoke sets revokedAt rather than deleting the row.
--
-- No backfill, deliberately. Existing BiometricEntry rows are left exactly
-- where they are - nothing is deleted - but nobody is treated as having agreed
-- to wording they never saw. A user with history is asked once, the next time
-- they add a number, and can still read, export and delete everything they
-- logged before without agreeing to anything.
CREATE TABLE IF NOT EXISTS "health"."BiometricConsent" (
    "userId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BiometricConsent_pkey" PRIMARY KEY ("userId")
);
