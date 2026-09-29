-- Photo food logging: the columns that let a FoodLog remember the picture it
-- came from, and the request ledger that makes a paid vision call accountable.
--
-- All of these are additive and nullable. Nothing here changes how an existing
-- row reads, and a food logged by search or a saved meal leaves every new column
-- null - which is the correct value, not a missing one. The seed catalogue, the
-- day totals and every saved meal are untouched by this migration.
--
-- ADD COLUMN IF NOT EXISTS rather than bare ADD COLUMN, for the same reason the
-- ledger migration uses IF NOT EXISTS on its CREATE TABLEs: this file is
-- hand-authored and a re-run against an already-migrated database should be a
-- no-op rather than an outage during a deploy.

-- ---- FoodLog: the photo behind a photo-sourced log -------------------------
--
-- photoPath is a GCS object path and deliberately not a URL. The bucket has no
-- public access, so a path is inert until a signed URL is minted for a specific
-- read - the same rule medicalDocumentStorage.js enforces for prescriptions.
ALTER TABLE "health"."FoodLog"
  ADD COLUMN IF NOT EXISTS "photoPath" TEXT,
  ADD COLUMN IF NOT EXISTS "photoProposedName" TEXT,
  ADD COLUMN IF NOT EXISTS "photoConfidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "photoModel" TEXT;

-- No index on photoPath, and the omission is a decision rather than an
-- oversight. Nothing queries by it: a photo is read only through the FoodLog
-- that owns it, and that lookup is already served by the existing
-- (userId, localDate) and (userId, createdAt) indexes.

-- ---- FoodPhotoRequestLog: what the vision call actually cost ---------------
--
-- The table already existed with a userId and a timestamp, which answers only
-- "is this user hammering the endpoint". These columns answer the question that
-- decides whether the feature is worth what it costs: how often the model was
-- right, how often the photo was abandoned, and how many tokens it took.
ALTER TABLE "health"."FoodPhotoRequestLog"
  ADD COLUMN IF NOT EXISTS "outcome" TEXT,
  ADD COLUMN IF NOT EXISTS "latencyMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "tokensIn" INTEGER,
  ADD COLUMN IF NOT EXISTS "tokensOut" INTEGER,
  ADD COLUMN IF NOT EXISTS "photoPath" TEXT,
  ADD COLUMN IF NOT EXISTS "model" TEXT,
  ADD COLUMN IF NOT EXISTS "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "abandonedAt" TIMESTAMP(3);

-- outcome is queried by the health-adjacent reporting queries ("how many photos
-- produced no food at all"), and the existing (userId, requestedAt) index cannot
-- serve a filter on a column it does not contain.
CREATE INDEX IF NOT EXISTS "FoodPhotoRequestLog_outcome_requestedAt_idx"
  ON "health"."FoodPhotoRequestLog"("outcome", "requestedAt");
