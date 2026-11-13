# Nutrition setup, structured doctor plans and food-score impact

Updated 2026-10-30. Dev rollout only; production unchanged.

## Behavior

Wellness and explorer accounts receive general health, fat-loss and doctor-plan goals. Training accounts retain all six choices. Saved training goals remain visible for explicit removal; incompatible legacy onboarding goals are not newly prefilled for non-training users. Existing onboarding facts remain available without a write.

The doctor-plan form asks for prescribed daily calorie/protein targets and food or meal instructions, then optional doctor name, speciality, clinic/hospital and registration number. Its final review offers an optional end date and notes. A checkbox and Save and apply plan explicitly confirm scoring use from today. Skipped numbers stay absent. Doctor details are labelled user-provided, not verified, and never earn points. Uploads and legacy text records remain records only.

Current versioned medical-record consent is required. The shared currentNutritionTarget reader overlays only confirmed, active prescribed fields; ordinary target history is not rewritten. Unspecified fields retain ordinary targets when available. Free text, prescribed maximum limits, meal timings and medical restrictions remain reminders; they are not interpreted as targets or converted into arbitrary penalties. Medication adherence and clinical outcomes are not inferred from food logs.

Only the existing nutrition score's calorie/protein target rules change their inputs. No point weights or biological-score thresholds change. Closed scores remain frozen; new closes record the applied document ID and numeric targets in a zero-point provenance line without physician identity or notes.

## APIs

`POST /api/health/ledger/medical-documents/plan-note` retains legacy description support and accepts an optional `plan` object:

- `confirmed: true`, today's ISO `startsOn`, optional inclusive ISO `endsOn`.
- `targets` with positive numeric `kcal` and/or `proteinG`; unknown target keys are rejected.
- Optional `foodInstructions`, `doctorName`, `speciality`, `clinic`, `registration`; final `description` is the optional note.

Confirmation, date/type/length and broad typo bounds are checked before storage. These bounds do not certify medical suitability. The server sets version 1 and authenticity user_provided_not_verified. Client-supplied ownership, storage paths and verification claims are ignored.

A structured save uses a per-user transaction lock, retires earlier structured records with supersededAt and creates the replacement. Expiry, revocation or deletion restores ordinary targets. Deleting a replacement never reactivates an older prescription. Prior records stay private and viewable/deletable. A failed database write attempts attachment cleanup and redacts errors that could include private write arguments.

`POST /api/health/ledger/foods/score-preview` is nutrition-consent gated and read-only. It accepts localDate and 1-30 items: foodItemId/grams/slot for additions, those fields plus replaceLogId for edits, or logId for an included item. Nutrients come from owned/shared server foods and stored snapshots, not caller-supplied values. Cross-owner records are unavailable.

Previews compare daily nutrition points from the real computeEarns engine, including main-meal coverage and nutrient bonuses. Edits remove the old portion before adding the replacement. Included items compare the day with and without that item. Impacts are marginal and non-additive, not fixed food ratings, forecasts of close-day caps/penalties or the separate blended health percentage. Measured zero is distinct from unavailable. Pending nutrition, frozen/historical days, paused/not-started scoring, locked food and missing targets return explicit unavailable states.

The preview resolves layers from persisted journey data instead of calling the journey loader that can sync unlocks or trigger referral work. The client batches visible rows, caches within the view and invalidates on day/slot/meal changes. Search, recent foods, portion confirmation and added-meal review show the estimate; queued offline items stay pending. Rule reasons are available in a tooltip. No paid AI calls are used.

## Storage and migration

Migration `20261029190000_structured_doctor_plan` adds nullable MedicalDocument.structuredPlan JSONB and supersededAt. It is additive and was applied to dev. Existing ownership gates, private medical/{userId}/ random attachment paths, short-lived signed links, delete/purge/account-erasure controls and medical-record retention cover the new fields. Ordinary multipart upload types and limits are unchanged. Physician details and instructions stay out of analytics and score snapshots.

## Verification

152 app tests passed; targeted analysis clean. The full health-service suite passed 1766 tests with 15 existing skips; 84 focused backend tests passed after the final scoring adjustment. Analytics registry, undeclared imports, migration parity and diff checks pass.

Real dev Prisma transaction checks passed structured save, replacement, target overlay, consent revocation and deletion without reviving old plans. All fixture writes rolled back. Tagged HTTP tests passed consent/auth/validation, owner isolation, private attachment read/delete, prescribed target reads, replacement/delete behavior and a positive real-engine preview of +20 nutrition points for a synthetic fixture. The preview created no food logs and did not mutate the fixture journey. Disposable records/files were removed. No customer health or consent data changed and no paid AI calls were made. This is test evidence, not a claim that a real user's score improved.

## Rollout and rollback

Build a tagged dev revision with no traffic, compare env/secret bindings and service account with the captured service, verify the APIs, then promote the exact revision after rechecking traffic. Existing healthMetrics/healthLedger flags and versioned per-user medical consent remain controls. No model/configuration/secret changes are required.

Rollback dev traffic to `health-service-dev-00150-zum`. Leave the additive nullable columns and private records in place; do not erase health data as a rollback. An app rollback removes the guided form and preview components while preserving previous meal review, ingredient editing, loading and onboarding reuse. Customer UI requires a reload/rebuild; no device binary is installed here. Production migration/deployment is outside this rollout.


Live dev revision: **health-service-dev-00154-xah**, 100% traffic at https://health-service-dev-pwixdiy6va-el.a.run.app. Tagged structured-plan-check tests passed on this exact revision before promotion. Env/secret bindings and service account matched the captured previous revision, and traffic was rechecked before switching. The synthetic HTTP tests confirmed a +20 nutrition-point preview, active target reads, replacement/deletion behavior, no preview meal writes or journey mutation, and complete fixture cleanup. Rollback is health-service-dev-00150-zum; no production change.

Primary backend changes: doctorPlan.js, doctorPlanNoteService.js, currentTarget.js, foodScoreImpact.js, scoreService.js, rowProgress.js, ledger routes/controller and the additive MedicalDocument migration. Primary client changes: doctor_plan_prompt.dart, food_score_impact.dart, meal_review.dart, food_log_screen.dart, medical_documents_screen.dart, medical_documents_cubit.dart and repository/data-source/model contracts. Tests accompany the structured plan, storage, real-engine previews, server gates and UI flows. Unrelated working-tree changes were retained.
