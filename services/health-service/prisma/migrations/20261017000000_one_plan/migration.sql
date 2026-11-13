-- One-plan scaffold (UA1): the stable-identity key rebuild matches suggested
-- rows by, so editing a slot or supplement schedule updates a row in place
-- instead of recreating it and losing today's tick.
--
-- Additive only. The column is nullable: existing rows (user, doctor, and
-- everything written before the journey) have no sourceRef, and that is an
-- honest null rather than a guess.
SET lock_timeout = '3s';

-- PlanItem: the generator's stable-identity key, e.g. 'supplement:<scheduleId>'.
ALTER TABLE "health"."PlanItem" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;

CREATE INDEX IF NOT EXISTS "PlanItem_userId_sourceRef_idx" ON "health"."PlanItem"("userId", "sourceRef");
