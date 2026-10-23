# E10 local backend rehearsal

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

## Disposable PostgreSQL rehearsal

Prerequisites: Node 24 (experimental module mocks), installed lockfile dependencies
at root/auth/booking, Docker daemon, and an already-local `postgres:16` image.
Install dependencies into this candidate's own directories if needed. During this
session ignored junctions reuse existing dependencies read-only for offline tests;
do not run package installation/client generation through those junctions.
The runner writes generated Prisma clients into its own ignored `.runtime/`.

```powershell
node tools/explore-e10/rehearse.mjs
```

The runner never pulls an image. It creates a randomly named, labelled container
with a loopback-only random PostgreSQL port, a random password and five uniquely
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
| `e10_old_chain` | Exact historical chain through the parent, populated predecessor, forward E2 deploy, byte-equivalent before/after rows for every previously applied migration |
| `e10_upgrade` | Parent schema **snapshot baseline**, populated predecessor, exact E2 SQL in transactions, baseline migration record retained |
| `e10_upgrade_empty` | Same snapshot baseline, empty predecessor |
| `e10_runtime` | Current auth/booking schema-diff setup plus production hand-authored check/triggers; real HTTP/DB cases independent of historical-chain readiness |

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
