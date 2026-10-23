# Explore core (E2 / E3-A)

The authority is auth-service, behind the existing private `/api/auth` gateway.
The files in `contract/` are frozen copies of `docs/explore-contracts` in the
customer-app repo: `catalogue-v1.json`, `generator-v1-fixtures.json` and
`api-fixtures.json`. Re-copy these files together whenever the upstream contract
changes. Tests resolve the vendored files relative to their own test file, so no
customer-app checkout is required. A consistency test checks the catalogue's
contentHash against the generator fixtures' catalogueHash and API manifest
bindings. This implementation uses the corrected full-radius scans and
`foodFind_` catalogue keys (packet commits `9bcbb2b` and `c1ea328`).

## Runtime behavior

- `GET /explore/catalogue`: required version/hash, retained historical catalogue;
  unknown version and hash mismatch are distinct errors.
- `GET /explore/collection`: merged location/reward history, descending instant
  and receipt ID, signed account-bound cursor, revision-pinned snapshot totals.
- `GET /explore/nearby`: grid only, complete spherical-cap scan before limiting,
  empty suggestions/drops and null daily set. Longitude wraps and pole rows clamp.
- `POST /explore/pickups`: grid claims resolve the already-published manifest and
  catalogue. Idempotency precedes manifest/evidence checks. Saved occurrence
  identity precedes freshness/expiry checks. Terminal rejections use HTTP 200.
  Gym/reviewed issuance, today, daily sets and reward issuance belong to B1/B2.

`exploreFoodFinds` is registered in the existing app-config feature registry and
defaults off. It gates nearby issuance. Catalogue/history and claims against
previously published epochs remain available during rollback, as required by
api.md. Disabling the flag never publishes a new manifest from a pickup.
The app-config client field is `exploreFoodFindsEnabled`; E8 owns app integration.

`ExploreCatalogue` retains the entire catalogue including immutable empty drop
configuration. `ExploreEpochManifest` binds the catalogue hash and all world
configuration. Publication uses transactional INSERT ON CONFLICT DO NOTHING,
then reads the committed winner. SQL triggers reject publication updates/deletes and receipt/claim updates;
account deletion can still remove personal records.
The v1 generator remains bundled for historical replay.

Pickup transactions lock the parent User row before creating/reading progress.
Every future reward writer must acquire that same lock and increment
ExploreProgress.revision in its earning transaction. Location/reward receipts
carry that revision for history snapshots. Receipt payloads are explicit,
proof-free canonical wire objects; only identities and revision/time indexes are
separate columns. Summary counts and milestones derive from those receipts in
that transaction rather than independent award counters.

Only an HMAC-SHA256 fingerprint of the canonical command and terminal receipt
ID/reason are kept for claim idempotency. The HMAC uses the existing JWT_SECRET;
claims fail closed with WORLD_UNAVAILABLE before any persistence if it is absent
or blank. The digest cannot be reproduced from the command alone. Reordered
object keys replay identically, while changed proof still conflicts for the same
claimId. Position, fix accuracy/speed/time and capturedAt are never
persisted, exported or logged. Request/parser/storage errors use redacted typed
errors. Cursor signatures also use JWT_SECRET. Keep this secret stable for
retained claimId replays; rotating it requires a fingerprint-key transition and
invalidates old cursors (clients restart pagination). No position is encoded in
a cursor.

Account export includes both receipt classes. Account deletion removes claims,
both receipt classes and progress in the existing account transaction; global
published configurations remain for replay by other accounts. No coins, food
logs, exercise, steps or One Plan data are written.

## Verification

From `services/auth-service`, run `npm test` (Node's existing experimental module
mock pattern). Generator tests cover every shared case. API tests run actual
local HTTP requests against the router with an in-memory Prisma substitute.
They cover all in-scope HTTP fixtures, timing probes, transport envelopes,
manifest publication scenarios, delayed first claim after catalogue change,
timeout replay, account isolation, rejection persistence, transaction rollback,
pagination during new inserts, export and deletion. App-local lifecycle
scenarios assert their observable server behavior; native queue/visibility/OS
behavior remains the app owner's responsibility.

Seven fixture cases are explicitly skipped as outside E2/E3-A: today; visited v1,
visited v2 and unsupported visited version (E4); and the three B1 daily-set/
breakthrough scenarios. Reward-receipt history is exercised even though this
increment exposes no reward issuance command. Existing cross-repository parity
tests also skip when their sibling app/admin checkout is absent.

`prisma validate`, client generation, and `prisma migrate diff --from-empty
--to-schema-datamodel prisma/schema.prisma --script` require no database access;
the latter only renders SQL. The new migration's tables, unique indexes, foreign
keys and referential actions have been compared to that rendered schema.

Still requiring a real disposable PostgreSQL database (not exercised here):

- Fresh migration chain and upgrade with an empty/dev-only CollectibleFind table.
- Native concurrent cold publishers, including different server configurations,
  must return one immutable winner; SQL triggers must forbid later mutation.
- Concurrent same/different claims must yield one receipt/revision/award;
  injected connection failure after commit must replay the original receipt.
- Native transaction rollback, foreign-key/unique constraints, repeatable-read
  pagination during concurrent writes, and account deletion/export after upgrade.

No database migrations were applied and no database-backed claims were made.
Mock serialization exercises application behavior; it is not evidence for
PostgreSQL isolation, constraints, migration execution or distributed races.

## Forward migrations and rollback

`20261023000000_exploration_core` adds the new tables and publication triggers.
`20261023000100_drop_unreleased_collectible_find` separately drops the unreleased
predecessor. The historical creation migration is unchanged. Dev/test predecessor
rows are discarded; there is no mapping or old-client fallback.

Before any later application of the drop, the release owner must resolve E0's
recorded production-row/released-caller verification TODOs. Preparing the forward
migration here does not assert those checks passed and does not apply it.

For an application rollback, switch exploreFoodFinds off while retaining these
history/queue endpoints and all published data. Do not restore code which queries
the dropped table, reverse applied migrations or delete receipts/configurations.
A later schema change must be another forward migration.

## Receipt telemetry (Increment A)

`telemetry.js` creates one `ExploreReceiptEvent` for each newly saved receipt,
and one for each new terminal rejected claim, inside the existing pickup
transaction. Replay creates no new outcome. Unique receipt/claim keys add a
database guard. The new forward migration is
`20261023170000_explore_receipt_telemetry`; historical migrations are unchanged.
This is prospective telemetry, with no retrospective backfill of older receipts
or rejected claims. Daily-set telemetry remains B1.

Auth startup polls the durable queue every 15 seconds, up to 25 events per pass.
Workers use `FOR UPDATE SKIP LOCKED`, await delivery, then acknowledge the row.
Failures retain it with exponential backoff capped at one hour. Process death or
an ambiguous sink commit can repeat delivery. The auth-local analytics adapter
uses the existing PostgreSQL pool/table/configuration, a transaction advisory lock
on a random delivery UUID, and a separate READ COMMITTED conditional insert to
deduplicate repeats in the sink. `_delivery_id` is transport metadata, unrelated
to claim, receipt or occurrence identity. Existing `track`/`ingest` remain as-is.
No new sink schema, gateway route or shared infrastructure is required.

Only `ANALYTICS_PROVIDER=postgres` with the existing `ANALYTICS_DATABASE_URL`
acknowledges durable delivery. `none`, `console`, `posthog`, missing configuration
and sink errors retain pending records; they are not successful delivery. A live
process with CPU time and a reachable sink is necessary for eventual delivery;
a suspended or stopped instance retains backlog for the next running instance.
Deployment/runtime scheduling and throughput verification remain release gates.

Saved properties are `source=location`, `occurrence_kind=grid`, and E9's
`duration_bucket`, derived from canonical encounter start/completion (not network
latency or client visible-session duration). Rejections contain `source=location`,
nullable `occurrence_kind` (`grid` for parsed grid IDs, null for unknown IDs), and
the server's terminal `reason`. No item/food identity, coordinates, proof,
fingerprint, exact encounter times or claim/occurrence/receipt IDs enter analytics
properties. The standard distinct account ID and event timestamp remain envelope
fields, following the existing PostgreSQL analytics convention.

Account export adds `exploration.receiptTelemetry` with coarse event properties
and delivery state, excluding internal receipt/claim keys. Deletion removes these
rows first in the existing local transaction, coordinating with dispatcher row
locks; a cascading User FK is an additional guard. Delivered records remain
until account deletion so replay cannot lose its deduplication marker. The
separate analytics sink retains the existing pseudonymous account-ID convention;
this change does not add a new sink erasure/export architecture.

Run the normal auth suite and `test/exploreReceiptTelemetry.test.js`. The opt-in
`test/exploreReceiptTelemetry.postgres.test.js` requires
`EXPLORE_TELEMETRY_TEST_DATABASE_URL` pointing to a disposable loopback database
named `explore_telemetry_test` (optionally followed by lowercase letters, digits
or underscores). It creates/drops only a random test schema, executes the exact
new DDL there against a minimal User table, and verifies native constraints,
rollback/cascade and actual concurrent sink SQL deduplication. It is a focused
SQL test, not a historical migration-chain or complete service/HTTP rehearsal.
See `docs/explore-receipt-telemetry-report.md` for evidence and remaining gates.
