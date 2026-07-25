-- Hand-authored, idempotent reconciliation migration — needed because dev and
-- prod started today's migration work from genuinely different states:
--
-- - dev's `gym` schema already had GymSlotPrice + the four plan-price columns
--   (added there via `prisma db push`, never captured in a migration before
--   today's baseline), so 20260724010000_baseline/20260724020000_gym_pricing_decimal
--   correctly matched dev (baseline recorded as already-applied, decimal
--   migration ran for real).
-- - prod's `gym` schema never got those `db push`es at all — GymSlotPrice
--   doesn't exist there, and Gym has no weeklyPlanPrice/monthlyPlanPrice/
--   quarterlyPlanPrice/yearlyPlanPrice columns. Both prior migrations failed
--   against prod for exactly this reason (baseline assumed an empty schema —
--   "Gym already exists"; the decimal migration assumed the plan-price
--   columns existed — "weeklyPlanPrice does not exist").
--
-- This migration is written to be safe to run against EITHER state: it
-- creates whatever's missing and converts whatever Float columns still
-- exist, using IF NOT EXISTS / conditional guards throughout. Against prod
-- (nothing exists yet) it creates everything, in Decimal, directly. Against
-- dev (everything already exists and is already Decimal) every statement is
-- a no-op. Do not "simplify" this into unconditional CREATE/ALTER statements
-- assuming one environment's starting state — that's exactly what broke on
-- the first two attempts here.

CREATE TABLE IF NOT EXISTS "gym"."GymSlotPrice" (
    "id" SERIAL NOT NULL,
    "gymId" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "price" NUMERIC(19,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GymSlotPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GymSlotPrice_gymId_startTime_key" ON "gym"."GymSlotPrice"("gymId", "startTime");
CREATE INDEX IF NOT EXISTS "GymSlotPrice_gymId_idx" ON "gym"."GymSlotPrice"("gymId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'GymSlotPrice_gymId_fkey' AND table_schema = 'gym'
  ) THEN
    ALTER TABLE "gym"."GymSlotPrice"
      ADD CONSTRAINT "GymSlotPrice_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "gym"."Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "weeklyPlanPrice" NUMERIC(19,2);
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "monthlyPlanPrice" NUMERIC(19,2);
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "quarterlyPlanPrice" NUMERIC(19,2);
ALTER TABLE "gym"."Gym" ADD COLUMN IF NOT EXISTS "yearlyPlanPrice" NUMERIC(19,2);

ALTER TABLE "gym"."Gym" ALTER COLUMN "sessionPrice" TYPE NUMERIC(19,2) USING "sessionPrice"::numeric(19,2);
ALTER TABLE "gym"."Gym" ALTER COLUMN "quotedPrice" TYPE NUMERIC(19,2) USING "quotedPrice"::numeric(19,2);
ALTER TABLE "gym"."GymSlotPrice" ALTER COLUMN "price" TYPE NUMERIC(19,2) USING "price"::numeric(19,2);
