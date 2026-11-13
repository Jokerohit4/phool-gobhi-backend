-- The photo-food loop, second wave: what happens to the things a photo shows
-- us that the catalogue does not stock, and the vector cache that lets a
-- future on-device matcher see the catalogue without paying for a vision call.
--
-- Three changes, all additive:
--
--   1. FoodLogSource gains 'photo_unmatched'. When the user CONFIRMS a photo
--      line the catalogue cannot name, the row is logged with a `nutrients`
--      snapshot of {"unknown": true} instead of being dropped (the old
--      behaviour left the food off the plate) or invented (a model that
--      supplies numbers). Day totals count these rows but never sum them.
--
--   2. FoodRequest gains `source`, so the demand queue can tell "people keep
--      typing a name we do not have" from "people keep eating a food we do not
--      have". Photo-sourced requests are auto-recorded at confirm time.
--
--   3. FoodEmbedding, the cached text vectors for the on-device matcher. A
--      table rather than a column on FoodItem so a model change (a different
--      embedding space) is new rows rather than a column rewrite.
--
-- IF NOT EXISTS throughout, for the reason the previous photos migration uses
-- it: this file is hand-authored and re-running it against an already-migrated
-- database must be a no-op rather than an outage during a deploy.

-- ---- 1. FoodLogSource.photo_unmatched --------------------------------------
--
-- ADD VALUE cannot always run inside an explicit transaction the way the rest
-- of these statements can, so the guard that makes this file re-runnable hides
-- inside a DO block exactly like the FoodRequestStatus type in
-- 20261010000000: check the pg_enum member, add it only if missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'health'
      AND t.typname = 'FoodLogSource'
      AND e.enumlabel = 'photo_unmatched'
  ) THEN
    ALTER TYPE "health"."FoodLogSource" ADD VALUE 'photo_unmatched';
  END IF;
END
$$;

-- ---- 2. FoodRequest.source ---------------------------------------------------
--
-- Where the demand came from. A TEXT with a default rather than an enum: the
-- set of demand signals is open (a future "saved-meal blocked on missing food"
-- would be another one), and adding a signal later must not need
-- ALTER TYPE. The picker path is the default, so every existing row reads as
-- a manual ask without a backfill.
ALTER TABLE "health"."FoodRequest"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'picker';

-- The triage read is now requestCount-first across ALL sources, so source
-- needs no index of its own. A per-source filter is a bounded scan over the
-- same (status, requestCount) index the queue already sorts by.

-- ---- 3. FoodEmbedding --------------------------------------------------------
--
-- One row per (food, model). `embedding` is a float vector stored as JSON: the
-- provider yields ~768 numbers per text, and a JSONB array is the cheapest
-- shape that Prisma can both write (@updatedAt, Json) and hand to the client
-- unchanged. Same no-DEFAULT rule on updatedAt as every table here — the
-- Prisma client writes it, and a column default would be a second silent
-- source of the value (see the note in 20261010000000).
CREATE TABLE IF NOT EXISTS "health"."FoodEmbedding" (
    "id"         SERIAL,
    "foodItemId" INTEGER     NOT NULL,
    "model"      TEXT        NOT NULL,
    "embedding"  JSON        NOT NULL,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodEmbedding_pkey" PRIMARY KEY ("id")
);

-- The matcher reads the whole catalogue as vectors in one space, per model.
-- Unique so a refresh is an upsert rather than an unbounded pile.
CREATE UNIQUE INDEX IF NOT EXISTS "FoodEmbedding_foodItemId_model_key"
  ON "health"."FoodEmbedding"("foodItemId", "model");

CREATE INDEX IF NOT EXISTS "FoodEmbedding_foodItemId_idx"
  ON "health"."FoodEmbedding"("foodItemId");