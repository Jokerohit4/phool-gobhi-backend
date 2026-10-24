# Parent backend completion review - 24 October 2026

This candidate integrates the queue registry with E10, enforces the queue wire
contract at ingestion, and corrects the registry handoff. It is a local source
candidate; it is not a deployed or newly PostgreSQL-accepted backend.

## Inputs and changes

- E10 base/evidence checkpoint: 22259ad636e00670aa3ba7278003b9d6fd7833a0.
- Registry 702d634 and handoff f574f74 incorporated as 19a6118 and ab4997c.
- Added exact seven-field/cross-field validation for the two queue observations.
- Kept public client-supplied distinct_id semantics explicit; no JWT-derived
  identity or authoritative receipt meaning is claimed.
- Added default-off EXPLORE_QUEUE_DIAGNOSTICS ingestion gate. Queue properties
  bypass IP/UA/device enrichment. Other events preserve existing behavior.
- Queue events use only the owned PostgreSQL provider; no console/PostHog fallback.
- Added a rehearsal-workflow preflight for gateway/schema/provider/real loopback
  HTTP checks, preserving branch scope, failure propagation and redacted uploads.
- Extended collector identities to the gateway, registry, schema, providers and
  new tests. Historical migrations, receipt logic and deployment workflows are
  unchanged. The source registry worktree and original hosted artifacts remain
  untouched.

## Validation

Using existing dependencies; no install, client generation, build, DB or Docker:

- 25 gateway/schema/provider tests passed:
  node --experimental-test-module-mocks --test test/gateway.test.js test/exploreQueueDiagnosticSchema.test.js test/queueDiagnosticProvider.test.js
- 10 rehearsal HTTP/tooling tests passed: ci-evidence, redact, migration-inputs,
  bootstrap-inputs, response-hold, error-envelope and http tests under
  tools/explore-e10. HTTP uses an in-memory Prisma substitute, not PostgreSQL.
- After collector/HTTP changes, the 25 gateway checks plus those two affected
  suites passed together (27 tests).
- Syntax and Git whitespace checks passed. Registry drift scan passed for the
  backend; its sibling-app auto-discovery was skipped by the isolated layout.
  The parent separately checks the app's eleven Explore client names.

Local logs are in tools/explore-e10/.runtime/parent (ignored). Final candidate
identity and changed-file SHA-256 values are recorded in the parent evidence
[evidence manifest](explore-parent-completion-evidence.json) after the source commit.

## Executed hosted evidence and remaining gates

Existing run 40077401208 tested exactly
7915189104fa8559c32ee487f7491b9e73c4ac56: 105 native checks, two snapshots and
both disposable bootstrap lanes passed. The raw historical lanes still failed
on the missing auth schema. Genuine historical upgrade and production-lineage
adoption are separate unproved gates; the founder's production collectible
inspection waiver is retained and is not measured migration evidence.

No hosted run tested these parent additions. A new exact-source run is required
before accepting them as runtime evidence. Do not overwrite the old report or
relabel its accepted source.

The analytics sink still lacks an approved delivered-data retention policy and
account analytics erasure hook. No secrets or live deployment configuration were
read. Both app and gateway queue-delivery gates stay off pending that work and
sink/query evidence. Device-side erasure cannot erase previously delivered rows.

Integrated app/backend/build/config acceptance, physical devices and the E11
seven-day diary remain unexecuted. Nothing was pushed or deployed. See
[E8 handoff](E8_QUEUE_DIAGNOSTICS_HANDOFF.md) for the exact trust/privacy boundary.
