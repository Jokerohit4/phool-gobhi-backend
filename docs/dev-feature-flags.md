# Dev feature flags enabled

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
