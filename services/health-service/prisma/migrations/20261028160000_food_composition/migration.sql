ALTER TABLE "health"."FoodItem"
  ADD COLUMN "dietaryType" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "ingredients" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "ingredientsEstimated" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "baseFoodItemId" INTEGER;
UPDATE "health"."FoodItem" SET "dietaryType" = CASE
  WHEN lower(name) ~ '(chicken|mutton|fish|rohu|prawn|beef|pork|lamb|meat)' THEN 'non_veg'
  WHEN lower(name) ~ '(egg|omelette|omelet)' THEN 'egg'
  WHEN "nonVeg" THEN 'non_veg' WHEN veg THEN 'veg' ELSE 'unknown' END;
CREATE INDEX "FoodItem_baseFoodItemId_idx" ON "health"."FoodItem"("baseFoodItemId");
