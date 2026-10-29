# Dev feature flags enabled

## Weekly habit summary activation, 30 October 2026

At the owner's request, the dev config now enables `weeklySummary` (registered
with a false default and a `coachJourney` dependency; `coachJourney` was already
on). Only `weeklySummary` changed, written to the stored AppVersionSetting
features with an AppConfigHistory row (changedBy null, note "Dev testing
activation of weekly habit summary"). The public dev app-config verifies it
enabled; the only flags still off in dev are `otp` and `profileCompletionBonus`.

The same day, closed-day behavioral averaging (B0.7,
`USE_CLOSED_DAY_BEHAVIORAL_AVERAGE`) was switched on in dev code for testing,
without the prod four-week comparison. It is a code constant, so it reaches
prod with the next dev->main merge: review it before that merge. Production
config, services and data were untouched.

## First-run Home activation, 26 October 2026

At the owner's request, the dev config now explicitly enables `homeIntroduction`
alongside the already enabled `coachJourney`. The stored feature set contains 26
flags. Live customer app-config reads verify both values are true for Android
and iOS. Only `homeIntroduction` changed; other configuration and production were
untouched. `AppConfigHistory` entry 5 records the change.

The new flag is registered with a false default, a `coachJourney` dependency,
and schema version 5. It is deployed on `auth-service-dev-00112-7jv`, serving
100% of dev traffic. The public config and authenticated admin registry both
verify schema version 5 and all 26 flags, including enabled Home Introduction.
Initial live activation required no deployment because app-config merges stored
feature entries; this deployment also makes the toggle available to the admin.

Validation: 41 registry, payload, profile and customer-app default-parity tests
passed. Follow-up admin integration validation: all 235 admin tests, type checking,
lint and the Next.js build passed. The full auth suite passed 903 tests with eight
skipped and no failures. Authenticated read-only verification of the deployed
admin Settings page confirmed both toggles checked and no registry drift warning.
The customer app still enrols only new server-confirmed accounts while both flags
are enabled; existing accounts retain full Home.

## Previous activation, 24 October 2026

Owner decision, 24 October 2026: keep all registered app feature flags ON in dev.
The dev AppVersionSetting row now stores enabled=true for all 25 registry flags.
Only exploreFoodFinds changed from the existing effective state. Other config,
maintenance settings and singleton provider/amount settings were preserved. An
AppConfigHistory entry records the change without impersonating an admin user.

The public dev app-config response verifies all 25 flags enabled and social on.
Gateway diagnostics are enabled on gateway-dev-00059-27d at 100% traffic, with
the first-party PostgreSQL provider. The dev gateway setting is persisted in
deploy/services.json so the next deployment retains it. No prod manifest block,
prod service or prod data was changed.

The customer app's DI defaults diagnostics ON only for its dev flavor. Its prod
flavor remains default-off. This applies to new dev builds; the live feature
flags are available to existing builds after configuration refresh.

This is an explicit dev-testing activation. Analytics delivered-data retention
and erasure remain unfinished rollout work, not represented as complete by
turning on these flags. Production activation remains separate. Account-bound
identity, strict seven-field schema, exclusion, cancellation and provider checks
are retained.

Verification receipts are under tools/explore-e10/.runtime/dev-flags. Client
validation: 55 focused tests (including full DI dev/prod isolation) and clean
whole-app analysis. The manifest comparison proved all prod settings unchanged.
