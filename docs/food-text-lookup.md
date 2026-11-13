# Database-first typed-food fallback

The main food picker first performs its existing database GET. Only an empty result for a
3-80 character query starts a second 1.2-second idle timer. Further typing/clearing/closing
cancels pending lookup, and an immediately advanced request ID discards stale responses.
The fallback is an explicit POST /ledger/foods/lookup behind nutrition consent and the
FOOD_TEXT_AI_LOOKUP=true server flag (off by default). Ordinary catalogue GETs and photo matching remain database-only. Ingredient editors use
the lookup POST only after an empty stable catalogue result. No migration is needed.

The server checks the full accessible catalogue again, serializes paid calls per user with
PostgreSQL advisory locks, rechecks the catalogue, and allows at most 20 paid lookups per user
per hour. It uses the existing provider rotation and text-only enrichment protocol; no model
or image settings are changed. Unknown/ambiguous names return no result; generic names such
as burger require a variant. Validated nutrition, servings and ingredients become an unverified
private food, searchable by the same user next time. Database nutrition always wins. Nothing
is logged as a meal until the existing user review/portion confirmation. Food identity and
nutrition remain estimates, not verified facts or web-search results. Other users never see
these private generated entries; account erasure already removes them.

All attempted calls are recorded as FoodPhotoUsage stage text_lookup, including model,
thinking and unavailable usage. Empty/invalid results are not saved. Successful entries act as
persistent reuse through normal DB search; the endpoint creates no diary/photo records.
Failures leave the manual add/request paths available. Normal estimates are displayed with
the existing unverified/approximate indicators.

Cost expectation: on the same model, typed lookup removes image and catalogue input. Output
nutrition and thinking can still dominate, so lower total cost is an expectation, not a measured
saving. Database hits avoid paid calls entirely. Provider reference, checked 2026-10-29:
https://ai.google.dev/gemini-api/docs/pricing (input, output including thinking billed separately).
No cheap-model switch or paid benchmark was performed. Comparisons must include miss rate,
all paid attempts, output/thinking tokens and repeat-query reuse; all reported token costs should
state tax/infrastructure exclusions. Do not quote a percentage saving without measurements.

Deployment/rollback: code is implemented locally, not deployed or enabled in this change.
Enable FOOD_TEXT_AI_LOOKUP only in the intended environment after review. Setting it false
stops new paid lookup calls; previously saved private foods remain available as normal entries.
The UI may need rebuilding. Existing model settings, photo caching and provider rotation remain
unchanged. Tests cover DB-first behavior, concurrent reuse, ownership, budgets, unknown foods,
delayed automatic lookup, typing cancellation and clearing the query.


## Dev activation and white-sauce-pasta verification (2026-10-29)

The earlier no-match report came while the fallback was not enabled on dev. It is now
enabled with FOOD_TEXT_AI_LOOKUP=true in deploy/services.json for dev only and deployed as
health-service-dev-00143-zow, serving 100% of dev traffic (Cloud Build
402b5c2f-c6a8-4035-a268-c1c157911465). No schema migration, model/key change or production
change was made. The only environment difference is the text-lookup flag; no secret overrides it.

A controlled `white sauce pasta` lookup returned exactly that food with validated nutrition,
ingredients and servings, unverified and private. The temporary food row was rolled back;
actual provider-attempt usage remains recorded in dev accounting under a synthetic test user.
The primary returned transient 503s, so text lookup now has at most two attempts through the
existing configured rotation, only retrying transient provider errors. Each attempt is separately
metered and counts toward the 20/hour limit. Semantic misses do not trigger retries. Cost
comparisons must include these attempted calls; unavailable failure usage is not zero cost.

Validation: full backend suite 1,731 passed / 15 skipped; 123 targeted app tests passed.
Tagged health returned 200, unauthenticated lookup POST returned 401, and a current-consent
account's empty-query POST returned 200 through the dev gateway with no generation or writes.
An account without nutrition consent remained forbidden as expected. General gateway live
read checks passed. The new app search code must be restarted/rebuilt; old builds only send
catalogue GETs and will continue to show the manual no-match choices.

Rollback: turn off FOOD_TEXT_AI_LOOKUP to stop paid fallback; prior serving revision was
health-service-dev-00122-7l6. Retain existing private estimated foods and normal database search.
This activation supersedes the earlier local-only status above.


## Ingredient fallback and Hinglish names

The ingredient editor in both food-search and photo review now has the same delayed fallback:
first its existing catalogue lookup, then one lookup POST after a 1.2-second stable empty query.
Clearing/changing the text or disposing the editor cancels pending AI work; stale responses are
ignored. Existing loading-state components are preserved. Results remain selectable ingredients
with their own weights and validated estimates; no meal is automatically logged.

Exact common aliases are expanded at database search, including laung/lavang/clove/cloves,
jeera/cumin, haldi/turmeric, dalchini/cinnamon, adrak/ginger, hing/asafoetida and ajwain/carom
seeds. Hindi-script spellings are included. These are whole-name mappings, not substitutions
inside longer dish names. Alias results preserve the same ownership/verification filters and
are deduplicated. Known aliases require an appropriate label or complete alias match: garlic
cloves must not satisfy a search for the spice laung. The primary ranking for ordinary food
searches remains unchanged.

For a missing known alias the paid lookup uses the canonical ingredient name, saves English
and original-query aliases, and reuses the private row on future queries in either language.
The text-only prompts also support other Hindi/Hinglish names, retaining aliases when an
identifiable food can be estimated. Ambiguous or unknown names still require clarification.
No shared catalogue nutrient values are overwritten, no alias backfill or schema migration is
required, and the existing lookup flag, per-user budget, rotation and usage accounting apply.

Controlled dev verification: laung returned Clove with nutrition/ingredients/servings and a
repeat English clove lookup reused the row without another paid call. Food writes were rolled
back; actual provider attempts remain in dev usage accounting under the synthetic test actor.
Unicode clove spelling was verified using its code points, not console encoding. Unit/widget
regressions cover alias ownership, garlic-clove exclusion, delayed lookup and typing cancellation.


Dev ingredient/Hinglish rollout (2026-10-29): health-service-dev-00145-mob, built by
35349bfc-8b31-4dbf-a95c-b740b0c24c10, now serves the alias-aware search and lookup support.
Runtime configuration, model selection and feature flags are unchanged; production was not
modified. No migration was needed. Full health tests: 1,734 passed, 15 skipped. Targeted app
tests: 59 passed; targeted Flutter analysis passed. Database-only checks for laung, clove and
Hindi script passed, including cross-user isolation and garlic exclusion; fixture writes were
rolled back, with zero provider calls for those database-only checks. Tagged health returned
200 and userless endpoints remained 401. App restart/rebuild is required to use the ingredient
editor's new fallback callback. Rollback revision: health-service-dev-00143-zow.
