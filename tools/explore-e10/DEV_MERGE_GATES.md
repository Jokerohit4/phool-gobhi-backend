# Dev merge validation

The app combined with local dev is tested separately in the app review branch.
Backend dev is an ancestor of this candidate. No dev merge/deployment is
performed by these checks. Both Explore and diagnostic activation remain off.

## Existing dev database inventory

`dev-baseline-audit.mjs` is pinned to project `phool-gobhi`, secret
`auth-service-secrets-dev`. It reads the database URL in memory through the
existing gcloud authentication, without printing or persisting that URL. It
does not accept a production-secret override or default to DATABASE_URL.

Run from an isolated clean checkout with existing dependencies and authorized
network access. Choose a new output filename:

```powershell
New-Item -ItemType Directory -Force tools/explore-e10/.runtime/dev-merge | Out-Null
node --test tools/explore-e10/dev-baseline-audit.test.mjs
node tools/explore-e10/dev-baseline-audit.mjs tools/explore-e10/.runtime/dev-merge/dev-baseline-new.json
```

The connection begins a repeatable-read, read-only transaction, verifies the
read-only setting, sets statement/lock timeouts, and always rolls back. It
discovers ledger schemas and uses the schema configured in the dev URL, rather
than guessing a ledger. It records migration names/checksums/status/times and
hashes of complete rows/logs, never raw migration logs. Schema inventory covers
columns, constraints, indexes, triggers, enums, sequence metadata, and aggregate
User/legacy counts. It does not select account records, tokens, receipts or
personal data. No CREATE/ALTER/DROP, migration, db-push, resolve, reset, backup or
clone operation is performed. Existing output files are refused.

An inventory can block on missing/mismatched/unfinished/unknown history or
predecessor-schema inconsistencies. A compatible inventory is explicitly
labelled as requiring an isolated upgrade rehearsal. It never sets
readyForDevMerge=true or upgradeExecuted=true. Record the actual inventory and
compare it to the parent prerequisites before choosing the existing lineage's
pending-migration executor. Rehearse the exact three forward migrations on an
authorized isolated clone, preserve all original ledger rows, and verify data,
sequence and rollback/receipt behavior. A new schema bootstrap is not that proof.

## Exact-source hosted checks

The dedicated workflow remains restricted to pushes on
`feature/explore-e10-backend`. It runs the gateway/schema/provider/HTTP and
audit-unit checks before the disposable PostgreSQL rehearsal. Its collector
includes both audit sources and the redacted ingestion log. It does not receive
shared/dev secrets or run the live inventory above.

After an authorized feature-branch push, verify the Actions run's exact head SHA,
download its artifacts into a new directory, and retain failure status as well as
native/snapshot/bootstrap/history/cleanup results and hashes. The unchanged raw
historical replay may still fail; do not hide it or call a green bootstrap a
genuine dev upgrade. The previously accepted 105-check run tested 7915189 and
does not accept a later source candidate.

## Restricted-session checkpoint

The parent session's GitHub request was denied at the network socket. gcloud can
identify its configured account locally, but dev Secret Manager access failed.
The inventory stopped before connecting to PostgreSQL. No live schema/history
result, latest-remote identity, new hosted run or successful upgrade can be
claimed from this session. See the dev merge report/evidence for exact source
and commands. No local Docker, DB server, install, generation or native build
is required for the prepared checks.
