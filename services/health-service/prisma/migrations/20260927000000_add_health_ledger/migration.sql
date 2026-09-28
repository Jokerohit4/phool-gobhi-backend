-- Hand-authored migration (no DATABASE_URL/shadow DB available in this
-- environment to run `prisma migrate dev`). Reconcile against the actual
-- dev/prod DB before applying — same caveat as the preceding migrations.
--
-- Health Ledger (2026-09-27). See
-- C:\Users\rohit\Phool-Gobhi\docs\phool-gobhi-health-ledger-plan-20260927.html
-- and the schema block above HealthGoalType for the reasoning that shapes every
-- table here.
--
-- Purely additive. Applying this changes nothing for anyone: every table stays
-- empty until a user has the healthLedger flag on AND opts in through the
-- 'nutrition' / 'medical_records' consent scopes. Nothing in this migration
-- alters an existing table except the two new HealthConsent scopes, which are
-- added to the existing default rather than replacing it.

DO $$ BEGIN
  CREATE TYPE "health"."Sex" AS ENUM ('male', 'female', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."HealthGoalType" AS ENUM ('build_muscle', 'lose_fat', 'recomp', 'endurance', 'general_health', 'doctor_plan');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."ActivityLevel" AS ENUM ('sedentary', 'light', 'moderate', 'very_active');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."DietPattern" AS ENUM ('veg', 'egg', 'non_veg', 'vegan', 'jain');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."MealSlot" AS ENUM ('breakfast', 'lunch', 'snack', 'dinner');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."FoodLogSource" AS ENUM ('search', 'photo_confirmed', 'saved_meal', 'custom');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."TargetSource" AS ENUM ('formula', 'user_edited');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."PlanItemKind" AS ENUM ('nutrition', 'workout', 'habit', 'doctor_medication', 'doctor_test', 'doctor_appointment', 'rest');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "health"."PlanItemOrigin" AS ENUM ('suggested', 'doctor', 'user');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "health"."HealthGoal" (
    "userId" INTEGER NOT NULL,
    "goal" "health"."HealthGoalType" NOT NULL,
    "sex" "health"."Sex",
    "age" INTEGER,
    -- Height, cached once at intake like sex/age. This is the documented final
    -- home for PersonalisationProfile.heightCm, which stays in place as a
    -- fallback (dropping a populated column is a data migration, not a
    -- feature-branch decision).
    -- There is deliberately no weight column: weight is a time series in
    -- BiometricEntry(metric='weight') and a second copy here would go stale.
    "heightCm" INTEGER,
    "startDate" TEXT NOT NULL,
    "targetWeightKg" DECIMAL(5,1),
    "targetDate" TEXT,
    "activity" "health"."ActivityLevel",
    "diet" "health"."DietPattern",
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activityIsMeasured" BOOLEAN NOT NULL DEFAULT false,
    -- Display-only eating-disorder guard: no red candles, one green line.
    -- Does not affect scoring, so toggling it cannot rewrite a snapshot.
    "calmMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthGoal_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."HealthCondition" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user_stated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthCondition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "HealthCondition_userId_idx"
  ON "health"."HealthCondition"("userId");

CREATE TABLE IF NOT EXISTS "health"."NutritionTarget" (
    "userId" INTEGER NOT NULL,
    "goal" "health"."HealthGoalType" NOT NULL,
    "kcal" INTEGER NOT NULL,
    "proteinG" INTEGER NOT NULL,
    "carbsG" INTEGER NOT NULL,
    "fatG" INTEGER NOT NULL,
    "fibreG" INTEGER NOT NULL,
    "waterMl" INTEGER NOT NULL,
    "micros" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "source" "health"."TargetSource" NOT NULL DEFAULT 'formula',
    "rulesVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NutritionTarget_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "health"."FoodItem" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "basis" TEXT NOT NULL DEFAULT 'cooked',
    "kcal" DECIMAL(8,2) NOT NULL,
    "proteinG" DECIMAL(8,2) NOT NULL,
    "carbsG" DECIMAL(8,2) NOT NULL,
    "fatG" DECIMAL(8,2) NOT NULL,
    "fibreG" DECIMAL(8,2) NOT NULL,
    "ironMg" DECIMAL(8,2),
    "magnesiumMg" DECIMAL(8,2),
    "calciumMg" DECIMAL(8,2),
    "zincMg" DECIMAL(8,2),
    "servings" JSONB,
    "veg" BOOLEAN NOT NULL DEFAULT true,
    "nonVeg" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" INTEGER,
    -- Provenance of the nutrient numbers ('ifct2017', 'usda', 'label-scan',
    -- 'user-entered', 'estimate'). Provenance, not authority: a row can be
    -- traceable and still unverified. Exists because "verified: false" alone
    -- cannot tell a reviewing nutritionist whether a value was looked up or
    -- typed from memory.
    "source" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    -- Sign-off attribution. `verified` alone is a flag a script can flip, and
    -- "a nutritionist checked these numbers" has to be a claim someone can
    -- actually check, so who / when / what they said are stored next to it.
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FoodItem_name_idx" ON "health"."FoodItem"("name");
CREATE INDEX IF NOT EXISTS "FoodItem_createdByUserId_idx"
  ON "health"."FoodItem"("createdByUserId");

CREATE TABLE IF NOT EXISTS "health"."FoodLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "foodItemId" INTEGER,
    "localDate" TEXT NOT NULL,
    "slot" "health"."MealSlot" NOT NULL,
    "grams" DECIMAL(8,2) NOT NULL,
    "servingLabel" TEXT,
    "servings" DECIMAL(5,2),
    "nutrients" JSONB NOT NULL,
    "source" "health"."FoodLogSource" NOT NULL,
    "photoCorrections" INTEGER NOT NULL DEFAULT 0,
    -- Name and veg flag copied at log time, alongside the nutrient snapshot.
    -- FoodLog.foodItemId is ON DELETE SET NULL, so the relation really does
    -- disappear when a custom food is deleted; without these the log would
    -- have nothing left to render.
    "name" TEXT NOT NULL,
    "nonVeg" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FoodLog_foodItemId_fkey" FOREIGN KEY ("foodItemId")
      REFERENCES "health"."FoodItem"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "FoodLog_userId_localDate_idx"
  ON "health"."FoodLog"("userId", "localDate");
CREATE INDEX IF NOT EXISTS "FoodLog_userId_createdAt_idx"
  ON "health"."FoodLog"("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "health"."SavedMeal" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slot" "health"."MealSlot" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedMeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SavedMeal_userId_idx" ON "health"."SavedMeal"("userId");

CREATE TABLE IF NOT EXISTS "health"."SavedMealLine" (
    "id" SERIAL NOT NULL,
    "savedMealId" INTEGER NOT NULL,
    "foodItemId" INTEGER,
    "name" TEXT NOT NULL,
    "nonVeg" BOOLEAN NOT NULL DEFAULT false,
    "grams" DECIMAL(8,2) NOT NULL,
    "servingLabel" TEXT,
    "nutrients" JSONB NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SavedMealLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SavedMealLine_savedMealId_fkey" FOREIGN KEY ("savedMealId")
      REFERENCES "health"."SavedMeal"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "health"."PlanItem" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" "health"."PlanItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'daily',
    "origin" "health"."PlanItemOrigin" NOT NULL DEFAULT 'suggested',
    "prescribedBy" TEXT,
    "prescribedNote" TEXT,
    "nutrientKey" TEXT,
    "targetValue" DECIMAL(8,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "autoGenerated" BOOLEAN NOT NULL DEFAULT false,
    "endsOn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PlanItem_userId_active_idx"
  ON "health"."PlanItem"("userId", "active");

CREATE TABLE IF NOT EXISTS "health"."PlanItemCompletion" (
    "id" SERIAL NOT NULL,
    "planItemId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "localDate" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "how" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanItemCompletion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanItemCompletion_planItemId_fkey" FOREIGN KEY ("planItemId")
      REFERENCES "health"."PlanItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlanItemCompletion_planItemId_localDate_key"
  ON "health"."PlanItemCompletion"("planItemId", "localDate");
CREATE INDEX IF NOT EXISTS "PlanItemCompletion_userId_localDate_idx"
  ON "health"."PlanItemCompletion"("userId", "localDate");

CREATE TABLE IF NOT EXISTS "health"."MedicalDocument" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "docDate" TEXT,
    "notes" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicalDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MedicalDocument_userId_idx"
  ON "health"."MedicalDocument"("userId");

CREATE TABLE IF NOT EXISTS "health"."DoctorAppointment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "doctorName" TEXT NOT NULL,
    "speciality" TEXT,
    "localDate" TEXT NOT NULL,
    "localTime" TEXT,
    "followUpDate" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctorAppointment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DoctorAppointment_userId_localDate_idx"
  ON "health"."DoctorAppointment"("userId", "localDate");

CREATE TABLE IF NOT EXISTS "health"."ScoreDaySnapshot" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "localDate" TEXT NOT NULL,
    "open" INTEGER NOT NULL,
    "high" INTEGER NOT NULL,
    "low" INTEGER NOT NULL,
    "close" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreDaySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScoreDaySnapshot_userId_localDate_key"
  ON "health"."ScoreDaySnapshot"("userId", "localDate");
CREATE INDEX IF NOT EXISTS "ScoreDaySnapshot_userId_localDate_idx"
  ON "health"."ScoreDaySnapshot"("userId", "localDate");

CREATE TABLE IF NOT EXISTS "health"."FoodPhotoRequestLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodPhotoRequestLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FoodPhotoRequestLog_userId_requestedAt_idx"
  ON "health"."FoodPhotoRequestLog"("userId", "requestedAt");

-- HealthGoal <-> NutritionTarget is a 1:1 the Prisma schema declares as a
-- relation, so the FK is added here too. ON DELETE CASCADE rather than
-- RESTRICT: the targets row is derived data belonging entirely to the goal,
-- and a goal without its targets is not a state worth preserving.
DO $$ BEGIN
  ALTER TABLE "health"."NutritionTarget"
    ADD CONSTRAINT "NutritionTarget_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "health"."HealthGoal"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The two new consent scopes join the existing default. Note this does NOT
-- grant them to anyone: a row carrying a scope is a record that the user
-- asked for it, and no row exists until they do. The default stays ['logs']
-- so a new grant is not implicitly a nutrition or medical-records grant.
--
-- The ALTER is written as a no-op-when-present so re-running is safe; the
-- dedupe is there because a partially-applied earlier attempt could have left
-- a duplicate behind.
UPDATE "health"."HealthConsent"
  SET "scopes" = ARRAY(
    SELECT DISTINCT unnest("scopes")
  )
  WHERE cardinality("scopes") <> cardinality(ARRAY(SELECT DISTINCT unnest("scopes")));
