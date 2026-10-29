# Food setup and meal review

GET /ledger/setup reports only unanswered questions after applying read-only prefill. Intake snapshots win; otherwise reuse onboarding birth date/gender, the saved height and latest weight. Explicit auth goals map only where equivalent (weight_loss to lose_fat, muscle_gain to build_muscle, general_fitness to general_health, sports_training to endurance). Do not infer doctor_plan from rehabilitation or an activity band from wellness status. The response includes the resolved persona so wellness messaging does not assume workouts. Prefill never writes HealthGoal or NutritionTarget; user confirmation remains the write boundary.

PATCH /ledger/food-logs/:id accepts optional foodItemId and servingLabel alongside the existing grams/slot fields. Selecting an owned personal recipe replaces that food on the same diary row. The server checks ownership of the log and replacement food, validates the portion, and recomputes its name, dietary/ingredient snapshot and nutrition from stored food data. It never accepts client nutrient values or creates a second diary row. An omitted portion retains the original grams when replacing a food.

The customer app reviews confirmed additions, supports Add more, portions/ingredient edits and removal, then Complete meal returns to the prior screen. Completion is navigation after persisted writes, not a second POST or a nutrition-day close. Offline rows are explicitly marked and await syncing before editing/removal.

Validation: health-service npm test passed 1,739 tests, with 15 skipped; analytics event drift and undeclared-import gates passed. A read-only dev-account audit found saved birth date, gender, height and weight, an empty goal placeholder, and no nutrition target. No account details were changed and no nutrition goal/activity was guessed. Tagged dev HTTP verification and deployment revision are recorded below.

Configuration/rollback: no migration, feature flag or model change. Deploy health-service to dev only. Deploy/reload the matching app for meal review and persona copy. To roll back, restore the previous health-service revision and matching customer app; existing log rows and personal recipes remain valid. Reverting only the server PATCH extension leaves ingredient edits unavailable in the new app, so roll back the pair together.


Dev deployment on 2026-10-29: `health-service-dev-00147-taz`, 100% traffic; source build `88117520-9c4c-4ecb-9348-4b446e75dff3`. Previous revision: `health-service-dev-00145-mob`. Environment bindings and service account were unchanged. No production rollout was performed.

Both the tagged and active service returned HTTP 200 for health and the test account's setup. The active response reported persona=wellness, prefilled age/sex/height/weight, and missing=[goals, activity]. Gateway live-read checks passed. A transaction against the dev database replaced a synthetic food log with an owned variant, verified updated nutrient/ingredient snapshots on the same log ID and no duplicate, then rolled all fixture rows back. No paid AI calls were made by these checks.

Backend rollback command:

```powershell
gcloud run services update-traffic health-service-dev --project phool-gobhi --region asia-south1 --to-revisions=health-service-dev-00145-mob=100 --quiet
```
