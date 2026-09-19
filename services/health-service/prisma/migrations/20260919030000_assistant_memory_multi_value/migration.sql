-- AssistantMemory was unique on (userId, key), which meant one value per
-- category per user and made every new fact overwrite the previous one:
--
--   "I'm allergic to peanuts"        -> allergy = peanuts
--   "I'm also allergic to shellfish" -> allergy = shellfish   (peanuts gone)
--
-- Losing an allergy is the worst instance of that, and an allergy is exactly
-- the kind of fact people add to over time. Cardinality is genuinely per key
-- rather than uniform -- a new goal DOES replace the old one, because that is
-- what changing your mind is -- so the constraint moves to the triple and the
-- one-vs-many decision is declared per key in memoryService.KEY_POLICY.
--
-- Including value also makes restating a fact idempotent instead of a write.
--
-- Safe to run as a plain swap: nothing wrote this table until 2026-09-19 and
-- no user has reached /coach on dev, so the widening cannot conflict. It only
-- ever admits rows the old index rejected.
DROP INDEX IF EXISTS "health"."AssistantMemory_userId_key_key";

CREATE UNIQUE INDEX IF NOT EXISTS "AssistantMemory_userId_key_value_key"
  ON "health"."AssistantMemory"("userId", "key", "value");

-- The unique index above no longer serves lookups by (userId, key) alone,
-- which is what the cap check and the per-key reads do on every write.
CREATE INDEX IF NOT EXISTS "AssistantMemory_userId_key_idx"
  ON "health"."AssistantMemory"("userId", "key");
