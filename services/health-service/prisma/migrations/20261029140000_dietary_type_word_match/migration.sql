-- 20261028160000_food_composition matched meat and egg words anywhere in a
-- name, so "Baingan / eggplant" became 'egg'. Re-derive the type with whole-word
-- matching (\m \M) for rows that were tagged egg or non-veg by name alone: the
-- row itself is not marked non-veg and its name has no such whole word.
WITH wrong AS (
  SELECT id, CASE WHEN veg THEN 'veg' ELSE 'unknown' END AS fixed
  FROM "health"."FoodItem"
  WHERE "dietaryType" IN ('egg', 'non_veg')
    AND "nonVeg" = false
    AND lower(name) !~ '\m(egg|eggs|omelette|omelet|chicken|mutton|fish|rohu|prawn|shrimp|seafood|beef|pork|lamb|meat|bacon|ham|gelatin)\M'
)
UPDATE "health"."FoodItem" f
SET "dietaryType" = wrong.fixed,
    -- The single-ingredient placeholder carries the same mistake; fix only
    -- entries whose own name has no egg or meat word.
    ingredients = COALESCE((
      SELECT jsonb_agg(CASE
        WHEN e->>'dietaryType' IN ('egg', 'non_veg')
          AND lower(e->>'name') !~ '\m(egg|eggs|omelette|omelet|chicken|mutton|fish|rohu|prawn|shrimp|seafood|beef|pork|lamb|meat|bacon|ham|gelatin)\M'
        THEN jsonb_set(e, '{dietaryType}', to_jsonb(wrong.fixed))
        ELSE e END)
      FROM jsonb_array_elements(f.ingredients) e
    ), '[]'::jsonb)
FROM wrong
WHERE f.id = wrong.id;
