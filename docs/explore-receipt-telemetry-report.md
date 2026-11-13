# Increment A backend receipt telemetry

2026-10-23. Implementation prepared for parent review. No merge, push,
deployment, flag change, shared database mutation or external message occurred.
Native PostgreSQL acceptance remains gated below.

## Isolation and inputs

- Worktree: `C:/Users/rohit/Phool-Gobhi/wt/backend-telemetry`.
- Branch: `feature/explore-receipt-telemetry`.
- Exact starting parent: `098f852e482b13d84fdc722d01d240cc2c3a74df`.
- Read-only contract checkout: `C:/Users/rohit/Phool-Gobhi/wt/explore-world`,
  HEAD `393789532448f3c5e97f561822ae03291d8941f1`.

Inspected existing worktrees first; requested path and branch were absent.
Created the isolated worktree at the requested checkpoint and verified a clean
status on the requested branch before edits. The source backend's pre-existing
deploy/health modifications and untracked files were preserved. No applicable
AGENTS.md was found in checked ancestors or this repository. No agents were
delegated. Ignored dependency junctions in this worktree point to the existing
backend's root/auth node_modules; those dependencies were used read-only, with
no install or client generation into the source checkout.

Read the E10 report, exploration README/implementation, plan C1-C7 and E2/E9
ownership/acceptance, frozen packet README/API/baseline/lanes and API fixtures,
and E9_HANDOFF.md. Inspected root/auth analytics helpers, auth startup, existing
account export/deletion conventions, Prisma schema/migrations and relevant tests.
E10's harness, frozen contracts, app sources and shared infrastructure are unchanged.

## Design and guarantees

The existing auth-local `utils/analytics.js` mirrors the backend's provider
architecture: `none`, `console`, PostgreSQL `analytics_events`, and PostHog.
Its existing track/ingest path swallows failures and does not await delivery.
It cannot safely establish a receipt outcome after a receipt transaction commits.
No existing durable auth analytics outbox was found.

`ExploreReceiptEvent` is a durable auth-local outbox, created in the same Prisma
transaction as the immutable terminal claim, new receipt and progress revision.
The existing parent User row lock remains unchanged. Only the new-receipt branch
creates a saved event. A different claim resolving to an existing receipt and
an exact saved replay create none. Each new terminal rejected claim creates one
rejected event; exact replay returns before event creation. Malformed commands,
idempotency conflicts and retryable errors create no terminal outcome event.
Concurrent commands remain serialized by the existing User lock. Unique receipt
and account/claim indexes independently guard event creation. An outcome-shape
CHECK permits exactly the two supported event classes. Outbox insertion failure
aborts the entire receipt/progress/claim transaction.

This is prospective telemetry from the new emitter. The migration does not
backfill receipts or rejected claims committed before this implementation.
Daily-set telemetry and reward issuance remain B1.

Auth startup drains up to 25 pending rows per pass, initially and every 15 seconds.
Each transaction locks one due row with `FOR UPDATE SKIP LOCKED`, awaits the
sink, then marks it delivered. Failures persist retry state with exponential
backoff capped at one hour; no exception text or proof is stored/logged. An
expired transaction or process restart leaves durable pending work. Concurrent
replicas use the same row-lock protocol. No remote call happens inside the
pickup/receipt transaction; the HTTP pickup API remains unchanged.

**Creation uniqueness and delivery are separate.** Delivery is repeatable,
including a sink COMMIT followed by lost local acknowledgement. The added
awaited PostgreSQL adapter reuses the existing configured pool/table. It opens
a READ COMMITTED sink transaction, obtains a transaction advisory lock keyed
by a random delivery UUID, then executes a conditional insert after the lock.
That subsequent statement sees the preceding sender's commit. Equality uses
the complete UUID; advisory hash collisions only serialize unrelated deliveries.
`_delivery_id` is opaque transport metadata in properties. It encodes no claim,
receipt, occurrence or position. All receipt dispatchers use this adapter.
The existing event index can filter the duplicate lookup by event; no new sink
DDL or shared migration is introduced. Sink deduplication depends on preserving
the sink rows and using this delivery protocol for these outbox records.

Only the existing `postgres` provider with a reachable analytics database
acknowledges delivery. Unsupported/no-op providers, absent configuration and
sink failures retain pending events; console output or an unverified PostHog
capture is never treated as durable delivery. Retries provide eventual delivery
when a process has CPU time and the sink is reachable, not an unconditional
scheduler/availability guarantee. Cloud Run suspension or no running instance
delays dispatch until execution resumes. Runtime scheduling, backlog monitoring
and throughput are release gates; no shared runtime configuration was changed.

## Privacy and account lifecycle

Saved properties are exactly `source=location`, `occurrence_kind=grid`, and
E9's `duration_bucket`. The bucket measures canonical encounter start through
completion, not upload latency, visible-session time or time to first find.
Rejection properties are exactly `source=location`, nullable `occurrence_kind`
(`grid` for parsed grid IDs, null for unknown IDs), and the server-derived typed
terminal `reason`. E9 duration boundaries are [0,10s), [10s,1m), [1m,5m),
[5m,15m), [15m,infinity). No arbitrary input object is spread into properties.

Coordinates, transient proof, command fingerprints, occurrence/claim/receipt IDs,
item identities, medical/food answers and exact encounter timestamps are absent
from analytics properties. The standard pseudonymous account distinct_id,
server source/service and event creation timestamp remain envelope fields, as
in the existing analytics storage architecture.

The outbox includes internal receipt/claim deduplication keys, coarse properties
and delivery state, never proof. Export scopes the read by account and adds
`exploration.receiptTelemetry`; it projects properties/delivery state and omits
the internal receipt/claim linkage. Deletion removes outbox rows first in the
existing auth-local transaction. That delete coordinates with dispatcher row
locks: a delivery owning the row finishes before deletion proceeds, or deletion
removes it before a worker can select it. A cascading User FK adds a guard.
Delivered outbox rows are retained until account deletion. The separate analytics
sink follows existing pseudonymous-ID retention conventions; this change does
not introduce platform-wide analytics erasure/export fan-out.

## Exact intended paths

- `docs/explore-receipt-telemetry-report.md`
- `services/auth-service/app.js`
- `services/auth-service/exploration/README.md`
- `services/auth-service/exploration/service.js`
- `services/auth-service/exploration/telemetry.js`
- `services/auth-service/prisma/schema.prisma`
- `services/auth-service/prisma/migrations/20261023170000_explore_receipt_telemetry/migration.sql`
- `services/auth-service/services/authService.js`
- `services/auth-service/services/exportService.js`
- `services/auth-service/utils/analytics.js`
- `services/auth-service/test/accountDeletion.test.js`
- `services/auth-service/test/exploreAccountLifecycle.test.js`
- `services/auth-service/test/exploreMemoryDb.js`
- `services/auth-service/test/exploreReceiptTelemetry.test.js`
- `services/auth-service/test/exploreReceiptTelemetry.postgres.test.js`

The new forward DDL matches Prisma-rendered columns, unique/index definitions
and FK actions, with the additional SQL-only outcome CHECK. No historical
migration was edited. No gateway, registry, E10 harness or API fixture changed.

## Executed commands and evidence

All Git commands use per-command `-c safe.directory=<target>`; no global Git
configuration was changed. Creation commands from the user home:

```powershell
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend -C C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend worktree list --porcelain
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend -C C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend status --short
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend -C C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend branch --list feature/explore-receipt-telemetry
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend -C C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend worktree add -b feature/explore-receipt-telemetry C:/Users/rohit/Phool-Gobhi/wt/backend-telemetry 098f852e482b13d84fdc722d01d240cc2c3a74df
```

Validation used Node v24.16.0 and Prisma 6.8.2. From auth-service:

```powershell
node --experimental-test-module-mocks --test test/exploreReceiptTelemetry.test.js test/exploration.test.js test/exploreAccountLifecycle.test.js test/accountDeletion.test.js
node --experimental-test-module-mocks --test test/exploreReceiptTelemetry.test.js test/exploreReceiptTelemetry.postgres.test.js test/exploreAccountLifecycle.test.js test/accountDeletion.test.js
node --experimental-test-module-mocks --test test/exploreReceiptTelemetry.test.js test/exploreReceiptTelemetry.postgres.test.js
node --experimental-test-module-mocks --test
$env:DATABASE_URL='postgresql://local:local@127.0.0.1:5432/explore_telemetry_validation'
node node_modules/prisma/build/index.js validate --schema prisma/schema.prisma
node node_modules/prisma/build/index.js migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

| Check | Observed result / evidence class |
| --- | --- |
| Initial combined focused run | 96 tests: 89 passed, 7 pre-existing scope skips, 0 failed |
| Final lifecycle/telemetry focused run | 17 tests: 16 passed, 1 native-DB skip, 0 failed |
| Final telemetry-only run after explicit sink isolation | 10 tests: 9 passed, 1 native-DB skip, 0 failed |
| Final complete auth suite | 899 tests: 884 passed, 15 skipped, 0 failed; 10,020.4482 ms |
| Prisma validate | Passed; dummy loopback URL, no DB connection |
| Prisma empty-to-schema diff | SQL rendered and new table/index/FK definitions compared, no DB execution |
| `node scripts/check-analytics-events.cjs` from repo root | 199 registered names, no backend drift; absent sibling app/admin/website scans skipped |
| `node --check services/auth-service/app.js` and `node --check services/auth-service/utils/analytics.js` | Passed from repo root |
| `git diff --check` | Passed |

Final suite skips are the existing 14 E10-documented skips plus the new opt-in
PostgreSQL test. The registry script recognizes conventional track calls and
still reports these outbox-emitted names as unobserved; that scan does not
establish emitter coverage. The executable telemetry tests establish call sites.

Final suite log SHA-256:
`981357874b9e25da0656288f53947f3f5d9ce2c0f89dedbe2a9b81d3c14388f2`.
Final telemetry-only log SHA-256:
`3890bb4d8de5f08f102292934eed71d7489a294f2899aef20810464a9804e35b`.
Temporary logs and rendered SQL were removed after recording these summaries
and hashes; they are not committed.

New application tests exercise 20 concurrent same/different claim commands,
discarded replies, late replay after grace, different accounts, idempotency
conflict, concurrent terminal rejection replay, distinct rejected claim IDs,
unknown occurrence mode, retryable/nonterminal errors, injected claim/outbox
failure with full rollback, retry/backoff, concurrent dispatcher invocation,
sink commit/local-ack failure and privacy/bucket boundaries. Account tests cover
nonempty export projection, account scoping and deletion ordering. The memory
substitute serializes transactions; it is not native PostgreSQL race evidence.
Sink tests evaluate the adapter's actual SQL protocol through a transactional
substitute and show repeated sends produce one sink row, including local-ack
failure. They are not claimed as native sink execution.

Prerequisite commands from the repo root:

```powershell
Get-Command psql,postgres,pg_ctl,docker -ErrorAction SilentlyContinue
docker info --format '{{.ServerVersion}}'
```

Only Docker was found. Docker exited 1: `docker_engine` named pipe absent;
its config read also reported access denied. No PostgreSQL server, container,
database or migration was created/applied. E10's harness was not changed or run.

## Remaining real-DB and release gates

1. On an available local disposable PostgreSQL, run the opt-in test from auth:
   set `EXPLORE_TELEMETRY_TEST_DATABASE_URL` to a loopback database named
   `explore_telemetry_test` (optional lowercase/digit/underscore suffix), then
   `node --test test/exploreReceiptTelemetry.postgres.test.js`. It creates and
   drops one random schema, runs exact new DDL with schema remapped against a
   minimal User table, and verifies native receipt/claim uniqueness, rollback,
   shape constraints, cascade and 24 concurrent actual sink inserts. This is
   a focused SQL gate, separate from historical migration-chain acceptance.
2. Rehearse the preserved full migration chain and populated upgrade including
   this new forward migration; compare prior applied history. Generate the
   updated auth Prisma client in an isolated runtime/release build. Run native
   pickup/HTTP races with same/different claims, real timeout/lost acknowledgement,
   transactional outbox failure, worker restart and sink connection failure.
   Existing E10 native gates remain open; their earlier mock results do not
   substitute for these checks.
3. Verify native concurrent dispatcher/deletion ordering and export after upgrade,
   queue row locking, sink commit ambiguity and DB-default isolation independence.
   Confirm actual sink permissions/table compatibility and query-plan throughput
   at representative volume. Run tests with separate auth/sink connections.
4. Review running-instance CPU/scheduling and backlog visibility before rollout.
   Without a running process or supported configured sink, pending events remain
   durable but delivery has no time bound. No configuration/deployment is part
   of this task. App/E11 gates and B1 daily sets remain outside this receipt.

Commit is limited to the exact paths listed above; its SHA is returned to parent
review separately so this document does not need a self-referential commit ID.
