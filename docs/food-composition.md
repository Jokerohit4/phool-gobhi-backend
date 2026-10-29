# Food composition and personal recipes

Food responses include `dietaryType` (`veg`, `egg`, `non_veg`, `unknown`),
`ingredients` (`name`, `grams`, `dietaryType`), `ingredientsEstimated`,
`isPersonal`, and `baseFoodItemId`. Ingredient weights describe 100 g of the
finished food. Standard recipes and photo-derived recipes are estimates.

`POST /api/health/ledger/foods/:id/customize` takes `baseGrams`, optional `name`,
and `additions: [{foodItemId, grams}]`. The nutrition consent gate applies.
The authenticated user's identity is supplied by middleware. Every referenced
food must be shared or owned by that user. Nutrition is calculated from stored
food values and ingredient weights; clients cannot provide replacement nutrient
values or ownership fields. Missing micronutrients remain unknown.

Customization inserts a new, unverified private FoodItem. It never updates the
base. Total recipe weight is limited to 5,000 g, with at most 20 added foods and
40 component ingredients. Meat takes precedence over egg when determining the
combined classification. Recipe classification and composition are included in
new log snapshots so later catalogue changes do not rewrite existing meals.

The additive `20261028160000_food_composition` migration supplies storage.
`node prisma/seed/backfill-composition.js` adds missing shared recipe metadata
and named burger variants without changing nutrient values or personal foods.
Photo recognition returns `choose_variant` when a generic food's filling is
unclear; the app asks for a specific variant before confirmation.
