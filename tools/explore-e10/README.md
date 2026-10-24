# E10 backend rehearsal

Run from this candidate's root. No command below deploys, sends messages, reads
shared DB credentials or changes a source lane. Never use a shared database URL.

## Checks that need no database

```powershell
node --experimental-test-module-mocks --test test/gateway.test.js
node --experimental-test-module-mocks --test tools/explore-e10/http.test.mjs
node scripts/check-analytics-events.cjs
```

Run `node --experimental-test-module-mocks --test` separately from
`services/auth-service` and `services/booking-service` for their existing suites.
The new HTTP test uses actual JWT verification and gateway proxying to a real
loopback auth router, with an **in-memory Prisma substitute** and captured
analytics. It is not PostgreSQL evidence. Existing E4 tests use real loopback
booking HTTP with in-memory attendance rows and substituted metadata responses.

## Hosted CI execution (prepared, not yet executed)

The laptop cannot support Docker. Keep Docker, dependency installation, client
generation and DB/build execution on the hosted runner. The dedicated workflow
is `.github/workflows/explore-e10-postgres.yml`, separate from deployment. It
triggers on pushes only to `feature/explore-e10-backend`; its job also checks the
exact branch ref, including for manual dispatch. There is no PR, schedule or
deployment trigger, cloud authentication, repository write permission or shared
DB credential. Checkout uses `fetch-depth: 0` and disables persisted credentials.
Preflight verifies parent schema commit
`5214fa8dd8242093e542bd89a169dcf9321753b2` is available.

After parent review and a separately authorized push, inspect the **E10 disposable
PostgreSQL rehearsal** Actions run for that exact source SHA. This preparation
does not push or dispatch anything. Manual dispatch is optional only if the
workflow is registered on the default branch; it cannot replace the feature-branch
push trigger for first execution. See [GitHub workflow dispatch documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatch).

The job uses Ubuntu 24.04 and Node 24, runs `npm ci --include=dev --no-audit
--no-fund` at root and with `--prefix services/auth-service` and
`--prefix services/booking-service`, then `docker pull postgres:16` and
`node tools/explore-e10/rehearse.mjs`. All dependencies live in the runner
checkout; Prisma postinstall generation is disabled, and the harness generates
its own isolated clients. The runner obtains the image; the harness still uses
`--pull=never`. No shared database or host bind mount is accepted.

Bash pipefail and explicit dependency command chaining preserve the first failed
prerequisite or rehearsal status. There is no `continue-on-error`. Collection and
upload use `always()` so failed checks still produce the artifact
`explore-e10-postgres-<source SHA>-<run attempt>` (14-day retention).
`ci-evidence.mjs` copies only an explicit list of logs and the rehearsal JSON into
ignored `ci-evidence/`. It never uploads `.runtime/`, dependencies, generated
clients, schemas or environment files wholesale. Logs are redacted at write time
inside the harness, including its random password, and again on collection.
`ci-source.json` records source commit, workflow/run identity, Node/Prisma versions,
Git blob/raw SHA-256 identities for harness/workflow/lockfiles/migrations and
SHA-256 identities for uploaded redacted logs. Tool/image identities are also in
CI preflight/image logs and the harness receipt. Missing rehearsal receipts are
labelled unavailable, never passes. Review both CI status and every receipt check
and cleanup field. Artifacts/cleanup are best effort after runner loss or forced
cancellation; absence of a receipt proves no acceptance result.

The normal harness `finally` removes only its named disposable container and
volumes, including when startup fails after creation. Container creation precedes
start so ownership is recorded before start can fail. Cleanup failure remains a
nonzero exit with the exact owned name. No broad Docker cleanup is performed.

CI preparation is **not executed PostgreSQL evidence**. Fresh historical replay,
populated historical upgrade/history retention, labelled snapshot upgrades and
all real HTTP/DB assertions still await a reviewed hosted receipt. Historical
migration failures remain schema-owner gates; never rewrite or resolve them in
the harness. The approved backend telemetry source is now included below;
hosted delivery evidence, E9 app inputs and integrated-app acceptance remain gates.

## Combined receipt telemetry candidate (PostgreSQL unexecuted)

Inputs: CI preparation `6198594243847b1c52861db8272b133b28a20e8b` and approved
backend telemetry `c2f0c81a2dccc4896f09a2bb522807ffeaf35314`, cherry-picked as
`4a5d136c52149e4c920010600d4a6e1d4ec7a419`. The production implementation and
migration are unchanged from that approved input.

`migration-inputs.mjs` enumerates baseline files from frozen parent Git tree
`5214fa8dd8242093e542bd89a169dcf9321753b2`, reads their exact bytes and writes
a new container-specific old-chain directory. No current-tree date prefix can
accidentally include telemetry in that baseline. Fresh/full and populated forward
deploys include all three forward migrations; snapshot setup explicitly applies:

1. `20261023000000_exploration_core`
2. `20261023000100_drop_unreleased_collectible_find`
3. `20261023170000_explore_receipt_telemetry`

Current-schema setup includes the new Prisma model and additionally installs the
exact SQL-only telemetry outcome CHECK extracted from the approved migration.
Generated clients stay in `.runtime/`. The real HTTP harness binds those clients;
it captures generic analytics while `telemetry-postgres.mjs`, imported before
those mocks, retains the real `deliverPickupBatch` and `insertReceiptEvent`.

Eight added native subtests run on each runtime/snapshot DB: separate auth/sink
connections, transactional save/reject creation and replay/races, outbox failure
rollback, actual concurrent sink SQL, retry/backoff, sink commit/lost reply and
local-ack rollback, competing workers with a held row, and export/deletion ordering.
The real HTTP timeout case also asserts one durable outbox outcome after replay.
Native SQLSTATE assertions check the unique and outcome constraints. A blocked
production account DELETE is observed through PostgreSQL lock state before the
dispatcher is released; guard triggers assert outbox-first erasure. Deletion
before worker selection and another account/global-manifest retention are checked.

`e10_sink` is a sixth disposable database in the same harness container. It uses
its own pg pool and a repeatable-read session default; the production adapter must
explicitly establish READ COMMITTED and deduplicate 24 concurrent deliveries.
The sink table is a local fixture with production columns, reset between the
three sequential DB suites. Provider selection, TLS/remote sink configuration,
`ensureTable`, the interval scheduler and external account-service fan-out remain
substituted/unexercised. Faults use native triggers and a deliberately thrown
error after a real sink COMMIT. Backoff eligibility is explicitly advanced for
retry tests; initial fixture backlog is made due independently of injected domain
dates. These are not process-crash, real network-loss, scheduler or throughput
acceptance receipts. Historical failures remain failures and are never resolved
or presented as successful snapshot replay.

Artifacts add `old-forward.local.log` and `telemetry-<auth DB>.local.json` (eight
planned checks, explicit failure/incomplete status), alongside the existing full
PostgreSQL logs and rehearsal receipt. Source identities now include the telemetry
test, baseline utility/tests, production emitter/adapter/lifecycle/schema and the
new migration. Artifact allowlists, redaction, failure propagation and container
cleanup remain in force. All these native checks are **prepared, unexecuted**.

Local tooling-only validation (no Docker/build/DB):

```powershell
node --check tools/explore-e10/rehearse.mjs
node --check tools/explore-e10/ci-evidence.mjs
node --test tools/explore-e10/redact.test.mjs tools/explore-e10/ci-evidence.test.mjs tools/explore-e10/migration-inputs.test.mjs
```

The collector test uses synthetic failure logs in a temporary Git fixture and
removes that fixture. It supplies no PostgreSQL or hosted Actions evidence.

## Disposable PostgreSQL rehearsal on the runner

Prerequisites: Node 24 (experimental module mocks), installed lockfile dependencies
at root/auth/booking, Docker daemon, and an already-local `postgres:16` image.
Install dependencies into the runner checkout's own directories. Earlier local
preparation reused ignored dependency junctions read-only for offline tests;
do not run package installation/client generation through those local junctions.
The runner writes generated Prisma clients into its own ignored `.runtime/`.

```powershell
node tools/explore-e10/rehearse.mjs
```

The runner never pulls an image. It creates a randomly named, labelled container
with a loopback-only random PostgreSQL port, a random password and six uniquely
isolated databases. It never accepts a database URL from the caller. It filters
inherited environment, uses test-only credentials, and does not load `.env`.
It always attempts removal of its own container and volumes in `finally`;
on failure its receipt identifies the exact container to remove. It never lists
or removes unrelated containers. No persistent host database directory is used.

Evidence is `.runtime/rehearsal-result.json` and the referenced local logs.
The command exits nonzero if any required check fails or infrastructure is absent.
Attach a reviewed, redacted receipt to the report after a successful real run;
syntax checks do not establish runtime correctness of this unexecuted harness.

The databases deliberately represent different claims:

| Database | Evidence produced |
| --- | --- |
| `e10_fresh` | Exact full historical auth `prisma migrate deploy`, untouched migration bytes |
| `e10_old_chain` | Exact frozen historical chain through the parent, populated predecessor, forward E2/telemetry deploy, byte-equivalent before/after rows for every previously applied migration |
| `e10_upgrade` | Parent schema **snapshot baseline**, populated predecessor, exact E2/telemetry SQL in transactions, baseline migration record retained |
| `e10_upgrade_empty` | Same snapshot baseline, empty predecessor |
| `e10_runtime` | Current auth/booking schema-diff setup plus production hand-authored check/triggers; real HTTP/DB cases independent of historical-chain readiness |
| `e10_sink` | Separate native analytics sink used sequentially by all three HTTP/DB suites |

Snapshot setup is never described as replay of historical migrations. The runner
does not resolve failed migrations, alter migration files or restore collectibles.
A fresh-chain failure remains a gate even if snapshot/runtime checks pass.

The HTTP/DB suite runs on the runtime database and both snapshot-upgrade
databases, so export/deletion and rollback are also checked after the actual
forward drop, rather than inferred from schema-diff setup alone.

`postgres.test.mjs` uses real generated Prisma clients, PostgreSQL transactions,
JWTs, gateway proxies, and full auth/booking routers. Node module substitutions
only bind the generated clients, inject clock/catalogue behavior,
capture analytics, and replace external account export/erasure fan-out. Gym
metadata is served by a loopback fixture. A test-only HTTP middleware holds a
committed save response past the client's real timeout; replay then reads the
committed receipt. This is not a native DB connection-failure simulation.
No real gym, food, health or wallet
service is contacted. The export/deletion implementation itself uses real DB
operations, but external platform erasure remains substituted.

Cases include cold publication races with different catalogues, same/different
claim races, account isolation/spoofing, post-commit response loss and replay,
next-window rotation, delayed first claim retaining M1/C1 after M2/C2, HTTP
timing/grace boundaries, native rollback/constraints/immutability, snapshot
pagination and account-bound cursors, mixed attendance sources, rollback queue
resolution, obsolete endpoint 404s and account export/deletion. Runtime snapshots
check every non-Explore auth/booking table (except the intentionally toggled
AppVersionSetting) and reject downstream mutation calls. This cannot prove
absence of mutation in real food/workout/coin/One Plan services or in the app.

Rollback here means flag-off issuance with history/catalogue/old-manifest claims
kept online, then flag-on with the same receipts. Saved commands replay after
grace; pending eligible commands resolve; expired commands reject terminally;
unpublished manifests remain retryable. No reverse SQL, API removal, old table,
legacy code or old collectible data is introduced.
