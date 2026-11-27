BEGIN;

ALTER TABLE "health"."GuidanceProfile"
  ADD COLUMN "hasCondition" BOOLEAN,
  ADD COLUMN "conditionType" TEXT,
  ADD COLUMN "conditionSource" TEXT,
  ADD COLUMN "conditionDeclaredAt" TIMESTAMP(3),
  ADD COLUMN "region" TEXT,
  ADD CONSTRAINT "GuidanceProfile_condition_check" CHECK (
    ("conditionType" IS NULL OR ("hasCondition" IS TRUE AND "conditionType" IN ('diabetes', 'prediabetes')))
    AND ("conditionSource" IS NULL OR "conditionSource" IN ('report', 'self_declared'))
  );

-- Keep eligibility for customers whose uploaded reports previously qualified them.
INSERT INTO "health"."GuidanceProfile" ("userId", "hasCondition", "conditionSource", "conditionDeclaredAt", "updatedAt")
SELECT "userId", TRUE, 'report', MIN("createdAt"), CURRENT_TIMESTAMP
FROM "health"."HealthReport"
GROUP BY "userId"
ON CONFLICT ("userId") DO UPDATE SET
  "hasCondition" = EXCLUDED."hasCondition",
  "conditionSource" = EXCLUDED."conditionSource",
  "conditionDeclaredAt" = EXCLUDED."conditionDeclaredAt"
WHERE "GuidanceProfile"."hasCondition" IS NULL;

COMMIT;
