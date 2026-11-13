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


## Removing ingredients from personal versions

The ingredient editor supports removing/restoring original components and removing newly added
components. Removal-only saves are allowed. Both photo and search flows use the same editor;
the action is named Edit ingredients. Removing every component requires adding a replacement.

The customization endpoint additionally accepts `removals: [{index, name}]`, where index refers
to the current server-normalized base ingredient list. Index/name pairs are checked against
that list; stale, duplicate or invalid references return 409. The server determines ingredient
weights and ownership; caller-provided nutrient/weight substitutions for removed parts are ignored.
The saved portion excludes removed grams, and the dietary classification uses the remaining
composition even if the personal recipe name still mentions the original filling.

Known ingredient catalogue references support subtraction from the base nutrient totals. When
those references are unavailable or the arithmetic produces invalid nutrients, the remaining
recipe is re-estimated via the existing provider rotation. No image, user ID, date or user-chosen
recipe title is sent: only the remaining ingredient names and normalized cooked/as-served weights.
All calls are measured as FoodPhotoUsage stage recipe_edit, with at most 20 estimates per user
per hour. Missing/invalid estimates fail explicitly without writing a food; unknown micronutrients
remain null. AI estimation does not hold an open database transaction. Original/shared rows and
previous diary snapshots are never changed. No schema migration is needed for removal support.

Tests cover removal-only saves, undo, replacing all components, portion/nutrient/dietary changes,
unchanged source foods, stale lists, privacy/ownership, invalid estimates, the hourly estimate
budget and text-only OpenAI-compatible enrichment. No paid provider call was made by these tests.


Dev rollout (29 October 2026): health-service-dev-00139-dat serves the removal API, built by
Cloud Build 0067107e-b416-4924-b458-b5cdca72354e. No migration or configuration/model change
was required. Health/auth checks passed, including rejection of an unauthenticated customize
request. The database removal smoke test verified nutrition, portion weight, dietary type,
and preservation of the original; all test writes were rolled back, with zero paid calls.
Full health suite: 1,723 passed, 15 skipped. Five targeted app tests passed; targeted Flutter
analysis passed. Recipe-save requests now allow 40 seconds for optional nutrition estimation.
Application rollback: route dev traffic to health-service-dev-00137-xeg. Production was not
changed. The app must be restarted/rebuilt for its new remove/restore controls to appear.
