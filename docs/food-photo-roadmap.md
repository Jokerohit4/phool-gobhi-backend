# Food-photo roadmap operations and measured findings

> Dev deployment update, 29 October 2026: deployed local health-service source to
> `health-service-dev-00133-fog` (Cloud Build `d0cb05f6-f20f-4dec-8c12-653df5e0d5bf`).
> Applied `20261029120000_photo_measurement` to dev only. Verified all three new tables,
> rollback-only test writes, and advisory-lock exclusion/release across two PostgreSQL connections.
> Full backend suite: 1,706 passed, 15 skipped, zero failed. Analytics/import preflights passed.
> Tagged revision health returned 200; contribution POST/DELETE without user headers returned 401.
> Runtime identity and complete environment/secret references are unchanged from the prior revision;
> model configuration and new optimisation/contribution flags remain unchanged/off.
> 100% dev traffic now targets this verified revision. Production was not modified.
> The initial no-deployment statements below describe the implementation handoff before this
> explicitly requested dev rollout. No paid recognition benchmark was run.
>
> Application rollback (additive tables retained):
> `gcloud run services update-traffic health-service-dev --project phool-gobhi --region asia-south1 --to-revisions=health-service-dev-00131-nix=100`

Implements design v4 (2026-10-29). No deployment, model switch, experiment enablement or
migration application was performed. Existing food-composition/wellness work was preserved.

## Measured findings

`python services/health-service/scripts/photo-inventory.py` reads deployed config and executes
aggregate SQL inside BEGIN READ ONLY separately for dev/prod. Only allowlisted model/flag
fields and key-presence booleans are printed, never credentials or photo paths.

Dev revision health-service-dev-00131-nix: primary configured gemini-3.5-flash, key present,
no explicit rotation override or new optimisation flags. Last 30 days: 7 ok (6 returned
3.6-flash, 1 returned 3.5-flash), 1 no_food, 3 provider_error with unavailable model.
67 shared/unverified catalogue foods, zero confirmed photo-backed logs. Ordinary logs cover
nine foods from one person. These are inventory candidates, not permission or strong labels.
Prod revision health-service-prod-00005-4gq: no primary photo model/key or explicit rotation
in inspected config. Database inventory unavailable; this does not mean zero production data.
No paid benchmark ran. Accuracy, p95 improvements and savings remain unmeasured.

## Configuration and rollback

Apply 20261029120000_photo_measurement after the existing composition migration, then generate
Prisma Client using health-service's pinned CLI. Adds FoodPhotoUsage, FoodPhotoRecognitionCache
and FoodPhotoContribution. Applied on dev 2026-10-29. 20261029140000_dietary_type_word_match
re-derives dietaryType with whole-word matching ("Baingan / eggplant" had become egg).
Deploy schema before application. Roll back flags first; retain additive tables while new code
runs. Contributions still require expiry/deletion operations after rollback.

All new flags default OFF; nutrition mode defaults baseline:

- FOOD_PHOTO_NUTRITION_MODE: baseline, same_call, separate.
- FOOD_PHOTO_SHORTLIST=true: catalogue hints come from three non-image signals - the user's
  frequent foods, foods logged in the current IST meal slot, and the most-logged foods overall.
  No signal yields the full catalogue. It is a hint, never a limit: every proposed name still
  goes through full-catalogue matching. The benchmark reports off-shortlist cases and whether
  they still matched. No user ID/history is sent.
- FOOD_PHOTO_LOW_RESOLUTION=true: Gemini 3 media resolution.
- FOOD_PHOTO_THINKING: unset provider default, numeric budget for Gemini 2.5, level for Gemini 3.
  A setting a model does not support is skipped for that model (the rotation mixes models), and an
  unknown nutrition mode falls back to baseline with a warning - never a 500 on every photo.
  Source: https://ai.google.dev/gemini-api/docs/generate-content/thinking
- FOOD_PHOTO_EXACT_CACHE=true; FOOD_PHOTO_CACHE_HOURS defaults 24, positive and at most 168.
- FOOD_PHOTO_CONTRIBUTIONS=true; FOOD_PHOTO_CONTRIBUTION_DAYS defaults 365, range 1-365.

Existing provider rotation/model settings remain authoritative and unchanged. Compact/text-only
enrichment is implemented by Gemini. OpenAI rotation retains full responses. Enrichment asks for
exactly one food and takes that answer even if the model rewords the name. A proposal still
missing nutrition for a new food is a retryable 502 and is never cached.
Catalogue nutrition/ingredients win. Missing macros cause explicit failure, never invented zeros;
missing micronutrients remain null. New validated estimates stay immediately loggable/unverified.

Cache hashes exact bytes, user, versioned config, rotation/model, MIME, attempt and prompt hints.
Only raw proposals are cached; never diary entries, paths, URLs or adjusted portions. Each upload
still gets its own photo and confirmation. No transaction is held around the paid call (that
pinned pool connections); two identical uploads in the same second may both pay. Failure/no-food
responses are not cached. Matching/ownership and
catalogue nutrition are resolved again on hits. Expiry is enforced on reads; sweep removes expired
rows. Account/consent erasure clears cache. No perceptual matching is present.

## Measurement and costs

FoodPhotoUsage records every recognition/enrichment call separately, including errors, actual
model version, latency, prompt/output/thinking/total/provider-cached tokens. Cache hits get an
explicit cache_hit row with zero provider usage. Null means unavailable, not zero. Blocked and
parse-failed responses retain returned usage. Unreachable/rejected calls have unknown usage;
do not count those as free. Successful request latency includes matching.

`node scripts/photo-cost-report.mjs usage.json pricing.json` (health-service directory) prices
exported usage against a versioned rate card. Rate-card format:

```json
{"version":"approved-card-id","effectiveFrom":"2026-10-29T00:00:00Z","effectiveTo":"2027-01-01T00:00:00Z","currency":"USD","tax":"excluded","models":{"exact-model-version":{"input":1,"output":5,"cachedInput":0.1}}}
```

Example numbers describe the format, not approved prices. Supply approved rates per million
tokens for exact returned versions and time windows. Thinking is charged at output rate.
Missing usage/rates make total null, with known subtotal and incomplete-call counts. All costs
explicitly exclude taxes, infrastructure, storage and review labour. INR needs a separately
versioned exchange assumption. No estimated savings are reported as achieved.

## Consent, retention and review

App review UI provides unchecked contribution control separate from logging, plus delete-all.
POST /ledger/food-photos/contribute requires own photo claim, enabled flag and consent version
food-research-2026-10-29-v1. It stores a decoded, EXIF-stripped centre crop under
food/{user}/contributions/, independently of diary images. No existing photo is bulk imported.
Contributions stay quarantined until human privacy/food review. No shared inference gallery exists.
DELETE /ledger/food-photos/contributions remains available without the flag and never blocks on
storage: a blob that fails to delete keeps its row, marked expired, and the sweep retries it. The
response reports `deleted` and `pending`. Photo/nutrition consent withdrawal does the same.

Label strength: a contribution starts `weak` (user accepted the model's answer) or `stronger` (the
user corrected it), taken from the confirmed log. Human review (scripts/photo-review.mjs) makes it
`strong`. Weak and stronger labels may only enter the reference split; calibration and final-test
rows must be `strong`. The pass rule also requires precision and unknown-food handling no worse
than the current configuration. Account
removal uses existing user-prefix blob erasure, covering contribution copies too.

The photo sweep (unconfirmed photos, expired contributions, cache) runs daily from
.github/workflows/sweep-food-photos.yml via POST /internal/ledger/food-photos/sweep; the admin
endpoint runs the same thing on demand. Scheduled workflows fire only from `main`. Review policy yearly. Human review
must reject faces/people and unsuitable crops. No automatic face detection or shared admission
is enabled. Retention maximum is one year.

Privacy/ToS review draft clause: With separate optional permission Gobhi keeps a cropped,
metadata-stripped copy of the selected food photo for human review and recognition evaluation
for up to the configured period (maximum one year). Logging does not require permission.
You can delete contributions; account deletion also removes them. We record consent version
and grant time. Include this wording in the pending privacy/terms review before enabling.

## Dataset/evaluation workflow

1. Collect newly consented varied photos of 30-50 frequently logged foods, unknowns, mixed
   plates and dietary look-alikes. Current dev inventory has insufficient labelled photos.
2. `node scripts/photo-review.mjs review.json`: supply id, reviewer, privacyReviewed=true,
   category (single/mixed/unknown/lookalike), foodIds, dietaryType and version. Unknown labels
   use empty foodIds, mixed plates the full item list. User confirmation is never a human label.
3. Set stable private PHOTO_DATASET_SALT, then `node scripts/photo-dataset-export.mjs output.json`.
   Read-only export includes reviewed/unexpired consented metadata, never photo bytes/paths.
   HMAC identities select deterministic person-disjoint 50/30/20 reference/validation/holdout
   splits. Export assigns deterministic fit/selection folds within validation; selection excludes fit rows.
4. Run configurations in an isolated benchmark environment, collecting predictions and total
   per-photo cost/latency across ALL calls. For validation replay use `node scripts/photo-benchmark.mjs manifest.json results.json --paid-benchmark`
   with explicit PHOTO_BENCHMARK_DATABASE_URL and PHOTO_BENCHMARK_PROVIDER_CANDIDATES. It requires
   a disposable catalogue-cloned benchmark database, local consented images keyed by ID in images
   ({path,mimeType}), configurations of allowed flag values and a versioned pricing card. It may
   create unverified food rows and request logs ONLY in that benchmark database. No replay ran here.
   Holdout replay remains a frozen release procedure; validation runner rejects holdout data.
5. `node scripts/photo-evaluate.mjs select validation.json freeze.json`: input has labels without
   holdout, arms keyed by config ID, exact configurations, baseline, holdoutId and rules
   (precisionLower/minCoverage). Predictions: id, accepted, foodIds, dietaryType, latencyMs,
   failed, costUsd. Selects cheapest passing validation arm. Freeze stores configs, rules,
   baseline and validation digest. Missing data cannot produce a passing winner.
6. `node scripts/photo-evaluate.mjs holdout final.json report.json`: input includes frozen object,
   matching holdoutId, human-reviewed holdout labels and frozen winner/baseline predictions.
   Checks person separation against frozen reference/validation people. Consumes holdout using
   exclusive marker under .photo-holdouts before reporting. Registry also rejects contributors from prior opened holdouts. Preserve registry and all artifacts
   in restricted durable release storage. Revised models require newly collected, person-disjoint
   holdouts; opened data stays historical. Never pick a runner-up using holdout outcomes.
7. Reports precision/Wilson 95% interval, coverage/interval, dietary errors, unknown false accepts,
   p95 latency, failures/interval and total provider cost. Missing predictions count as failures,
   missing costs make total unavailable. Final pass checks frozen precision/coverage, zero dietary
   errors and lower total cost. Aim for 300+ final photos and 10+ per supported food.

Limitations: local holdout markers are process safeguards, not a hostile-operator security boundary.
Maintain historical person-disjointness, durable registry access control, fresh holdouts and separate
fitting/selection folds operationally. Pricing needs approved rate cards; production database access
is unresolved. No live benchmark, automatic model selection deployment or performance claim.

## Verification

107 focused backend tests passed (measurement, cache concurrency/expiry/failures, compact/enrichment
request shapes, both provider adapters, recognition/review, consent revocation, erasure and storage).
Prisma Client generated; schema validated with placeholder local DATABASE_URL. Flutter targeted
analysis passed; new contribution opt-in widget test passed. Migration and cross-instance locks
still require a real PostgreSQL integration run. No deployment or paid call occurred.
