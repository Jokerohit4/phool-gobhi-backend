# Queue diagnostics: parent integration handoff

This document supersedes the inaccurate authentication/enrichment claims in
702d634 and f574f74. Those source commits remain preserved in Git.

## Source and scope

Backend base: E10 evidence checkpoint 22259ad636e00670aa3ba7278003b9d6fd7833a0.
Registry source: 702d634, with validation addendum f574f74, incorporated as
19a6118 and ab4997c on feature/explore-parent-backend.
App base: reviewed E8 combined candidate 6657ab4, including E5 1127d6d and
E9 contracts f22298d. Parent changes implement account-bound delivery.

The two registered client observations are explore_pickup_queue_issue and
explore_pickup_queue_resolved. Neither is an authoritative saved/rejected
outcome. The existing nine Explore event contracts and receipt outbox remain
unchanged.

## Actual trust boundary

POST /api/events is public. authMiddleware strips client identity headers and
bypasses JWT verification for this route. distinct_id is supplied by the client,
not derived from a verified JWT. The app binds it to its coherent originating
account, but a caller can forge it. Do not use these events as proof of account
activity, unique pickups, awards, saves or eligibility.

The handler now validates all seven property names, types, enum values and
cross-field rules using utils/exploreQueueDiagnosticSchema.js. Extra fields,
missing fields, unknown names and inconsistent age/resolution/phase combinations
are dropped. The queue-specific path requires a nonblank account distinct_id
of at most 200 characters. Invalid events still return the existing 202 response;
202 proves neither persistence nor query availability.

## Complete metadata behavior

Queue events bypass gateway IP/user-agent/OS/browser/device enrichment. Exactly
the seven sanitized property fields reach ingest. The first-party PostgreSQL
sink adds its normal event/distinct_id/source/service/server-ts columns; it does
not add app/platform/session properties. Ordinary analytics retains its existing
request enrichment and provider behavior.

The app uses a private Dio per immutable account handle, never the mutable
analytics facade, global ApiClient, current-token lookup or location interceptor.
No Authorization, traits, anonymous/session ID, client timestamp, proof,
coordinates, occurrence/claim ID or raw elapsed values are attached. The only
account identity in the JSON body is distinct_id. Requests time out after five
seconds, with no retries, persistent delivery queue or payload/error logging.

## Lifecycle and independent activation gates

The root owner suspends dispatch immediately during credential changes. Coherent
same-account refresh resumes the same handle/coordinator. Logout, matching
conditional expiry, deletion/global end and account replacement revoke old
handles permanently and cancel their requests. A stale A rejection cannot revoke
B. An old closure stays revoked even after A signs in again. Exclusion cancels
in-flight sends and drops new work; disabling exclusion does not replay samples.
Cancellation cannot retract a request already received by the server.

Both activation gates default off and have not been changed:

- App build define EXPLORE_QUEUE_DIAGNOSTICS=true, with ANALYTICS_PROVIDER=firstparty.
- Gateway EXPLORE_QUEUE_DIAGNOSTICS=true. Its sink must use ANALYTICS_PROVIDER=postgres.

The sink explicitly drops these two events for none/console/PostHog, with no
fallback logging or external provider. Existing feature flags also remain off.
Do not enable delivery until the gates below have executed evidence.

## Retention and erasure: unresolved deployment gate

The existing analytics sink has no delivered-data retention policy or account
analytics erasure hook. Clearing the device sidecar or resetting analytics
identity does not delete already-ingested rows. No secret value or deployed
provider configuration was read or inferred during this review.

Delivery therefore remains disabled pending an approved retention policy,
account-erasure implementation and execution against the intended analytics
store, plus exact sink/query/runtime identities. Client sample loss and crash
uncertainty remain documented in E5. Device suspend-inclusive elapsed timing is
unverified; the app continues to use wall_estimate/unknown.

## Validation and historical evidence

Parent tests cover exact serialized envelopes/headers, held dispatch, in-flight
cancellation, refresh, replacement, re-login, matching/stale expiry, no mounted
flow, exclusion, schema rejection and provider boundaries. See the parent
completion report for final commands/counts and candidate commits.

The E10 hosted run 40077401208 tested source 7915189: 105 native checks passed,
two snapshots and both disposable bootstrap lanes passed. Raw historical replay
still failed on the missing auth schema; genuine historical upgrade and
production lineage remain unproved. The parent additions have only local
lightweight/Flutter validation until a new exact-source hosted run is recorded.
No historical migration, original artifact or existing deployment workflow was
changed. No database, container, native build, install, push or deployment ran
as part of these parent changes.
