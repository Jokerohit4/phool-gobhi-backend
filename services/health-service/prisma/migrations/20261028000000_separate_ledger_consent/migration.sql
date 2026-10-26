CREATE TABLE "health"."LedgerConsent" (
  "userId" INTEGER NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "scopeVersions" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LedgerConsent_pkey" PRIMARY KEY ("userId")
);

-- Keep existing active ledger grants and their wording versions. A revoked
-- device consent did not grant active ledger consent under the old behavior,
-- so it is intentionally not migrated as an active record.
INSERT INTO "health"."LedgerConsent"
  ("userId", "grantedAt", "revokedAt", "scopes", "scopeVersions", "updatedAt")
SELECT
  hc."userId",
  hc."grantedAt",
  hc."revokedAt",
  ARRAY(
    SELECT scope
    FROM unnest(hc."scopes") AS s(scope)
    WHERE scope IN ('nutrition', 'medical_records', 'photo')
  ),
  COALESCE((
    SELECT jsonb_object_agg(entry.key, entry.value)
    FROM jsonb_each(hc."scopeVersions") AS entry
    WHERE entry.key IN ('nutrition', 'medical_records', 'photo')
  ), '{}'::JSONB),
  CURRENT_TIMESTAMP
FROM "health"."HealthConsent" hc
WHERE hc."revokedAt" IS NULL
  AND hc."scopes" && ARRAY['nutrition', 'medical_records', 'photo']::TEXT[];

-- Remove only ledger-owned scopes and their version entries from the OS
-- permission record. Other HealthConsent scopes (logs, cycle tracking,
-- location routes) keep their existing meaning and values.
UPDATE "health"."HealthConsent" hc
SET
  "scopes" = ARRAY(
    SELECT scope
    FROM unnest(hc."scopes") AS s(scope)
    WHERE scope NOT IN ('nutrition', 'medical_records', 'photo')
  ),
  "scopeVersions" = COALESCE((
    SELECT jsonb_object_agg(entry.key, entry.value)
    FROM jsonb_each(hc."scopeVersions") AS entry
    WHERE entry.key NOT IN ('nutrition', 'medical_records', 'photo')
  ), '{}'::JSONB)
WHERE hc."scopes" && ARRAY['nutrition', 'medical_records', 'photo']::TEXT[];
