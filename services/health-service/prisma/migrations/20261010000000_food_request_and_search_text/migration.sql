-- Two things the food picker could not do.
--
--   1. searchText on FoodItem - the haystack search actually runs against.
--   2. FoodRequest          - a food a user could not find, submitted from the
--                             picker's empty state.
--
-- Both are additive. No existing row changes meaning, every log keeps its
-- nutrient snapshot, and the day totals are untouched. IF NOT EXISTS throughout
-- for the reason the ledger migration uses it: this file is hand-authored and
-- re-running it against an already-migrated database should be a no-op rather
-- than an outage during a deploy.

-- ---- FoodItem.searchText ---------------------------------------------------
--
-- Why this column exists at all, since name and aliases are both already
-- searchable in principle.
--
-- Prisma's `has` on a String[] is an EXACT array-element match. So an alias of
-- 'omelette' is found by "omelette" and by nothing else - not "omlet", not
-- "omelette b" - and `name: { contains }` never sees aliases at all. The
-- result was a picker that only finds a food by its exact English spelling or
-- by an exact alias, which is not how anybody searches for dinner.
--
-- Folding name + every alias into one lowercased string turns the whole thing
-- into an ordinary `contains`, which Postgres can serve and Prisma can express.
--
-- The backfill is NOT optional. Adding the column with a default of '' and
-- deploying without this UPDATE leaves every existing row with an empty
-- haystack, and each one becomes unfindable except by exact name - the search
-- would get strictly worse than before this migration, silently.
-- `array_to_string` handles the empty and NULL aliases cases; COALESCE covers
-- the NULL that `||` would otherwise produce.
--
-- The ADD COLUMN has to come first, and cannot be left out even though it looks
-- like the disposable part: the backfill and the index below both reference the
-- column, so a file missing the ALTER fails on its first statement rather than
-- at application startup. Same failure either way, one statement earlier.
ALTER TABLE "health"."FoodItem"
    ADD COLUMN IF NOT EXISTS "searchText" TEXT NOT NULL DEFAULT '';

UPDATE "health"."FoodItem"
SET "searchText" = LOWER(
      "name" || ' ' || COALESCE(array_to_string("aliases", ' '), '')
    )
WHERE "searchText" IS NULL OR "searchText" = '';

-- Written after the backfill rather than before, so the index is built once
-- over populated values instead of being updated row by row as the UPDATE runs.
--
-- A plain btree, deliberately. `contains` becomes a leading-wildcard ILIKE,
-- which a btree cannot serve - this index will not accelerate substring search.
-- It is here for the exact-alias and exact-prefix lookups that btree does
-- serve, and because a few hundred rows do not need more. If the catalogue
-- ever reaches IFCT scale (several thousand foods, imported rather than
-- hand-written) this is the point to add `pg_trgm` with a GIN index over
-- searchText, not before - see the schema comment on the column.
CREATE INDEX IF NOT EXISTS "FoodItem_searchText_idx"
  ON "health"."FoodItem"("searchText");

-- ---- FoodRequest: foods users could not find -------------------------------
--
-- The catalogue is hand-written and finite, and a small hand-written catalogue
-- is not enough to search for dinner. A user searching "omelette" and finding
-- nothing could only give up, log something adjacent and wrong, or write the same
-- note in a free-text field nobody reads. This table is where that third option
-- lands, and it doubles as a real-demand-ordered backlog for growing the
-- catalogue.
--
-- Deliberately NOT a path into FoodItem. No trigger, no service write - a
-- request is a request, and turning one into a nutrient value is a job for
-- somebody who can source it. A `status` column is a human decision made in
-- this table, and only this table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'FoodRequestStatus' AND n.nspname = 'health'
  ) THEN
    CREATE TYPE "health"."FoodRequestStatus" AS ENUM ('pending', 'resolved', 'declined');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "health"."FoodRequest" (
    "id"         SERIAL,
    "userId"     INTEGER NOT NULL,
    "name"       TEXT    NOT NULL,
    "query"      TEXT,
    "detail"     TEXT,
    "status"     "health"."FoodRequestStatus" NOT NULL DEFAULT 'pending',
    "resolvedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    -- Demand, not identity. A hundred people wanting omelette is ONE backlog
    -- entry with a hundred on it, because the queue is read by a person
    -- scanning names. Not reset when a declined request is reopened: how often a
    -- dish has been asked for is a property of the dish.
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DEFAULT on updatedAt, and that is load-bearing rather than an
    -- omission. `@updatedAt` is applied by the Prisma client on every write, so
    -- a column default here would be a second, silent source of the value: a
    -- write that forgot the field would still look correct, and the row would
    -- claim it was touched when it was not. It is also drift - `prisma migrate
    -- diff` reports a default the datamodel does not declare - and the rest of
    -- this service gets this right already (every "updatedAt" in
    -- 20260927000000_add_health_ledger is plain NOT NULL). One migration does
    -- carry the default and it shows up in every diff as unexplained churn.
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodRequest_pkey" PRIMARY KEY ("id")
);

-- userId first: "what has THIS person asked for" is the only query the product
-- makes today, and it is the one the consent gate sits in front of.
CREATE INDEX IF NOT EXISTS "FoodRequest_userId_idx"
  ON "health"."FoodRequest"("userId");

-- The admin triage read is pending, most-wanted first. requestCount leads so a
-- dish twenty people asked for sorts above one person asking twice a month,
-- which is the ranking that answers "what should we add next".
CREATE INDEX IF NOT EXISTS "FoodRequest_status_createdAt_idx"
  ON "health"."FoodRequest"("status", "createdAt");

-- The queue's actual sort is (status, requestCount DESC, createdAt ASC). This
-- covers the first two terms; without requestCount in an index every poll
-- re-sorts the whole pending set, which is fine at launch and not fine once the
-- backlog is a few thousand rows.
CREATE INDEX IF NOT EXISTS "FoodRequest_status_requestCount_idx"
  ON "health"."FoodRequest"("status", "requestCount");

-- No foreign key on userId, matching every other table in this service. The
-- health database has no FK to auth-service (a different database entirely),
-- so a FK could not be declared even if it were wanted. Deletion is instead
-- explicit, in consentService.deleteAllDataService - and asserted there.