SET lock_timeout = '3s';

-- Equipment ids the coach recommends (customer app). Idempotent: the column
-- may already exist on a database where this was applied by hand.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'User' AND column_name = 'recommendedEquipment') THEN
    ALTER TABLE "auth"."User" ADD COLUMN "recommendedEquipment" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
  END IF;
END $$;

-- Prisma scalar lists are never null; make sure no row reads back as null.
ALTER TABLE "auth"."User" ALTER COLUMN "recommendedEquipment" SET DEFAULT ARRAY[]::INTEGER[];
UPDATE "auth"."User" SET "recommendedEquipment" = ARRAY[]::INTEGER[] WHERE "recommendedEquipment" IS NULL;
