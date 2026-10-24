# Explore dev merge review - 24 October 2026

Backend review is based on feature/explore-e10-backend at ec862f1, which includes
local backend dev 5214fa8. The production source and forward migrations have not
changed during this review. No dev merge or deployment is approved by this record.

## Completed locally

- Added tools/explore-e10/dev-baseline-audit.mjs, pinned to dev Secret Manager
  and a repeatable-read/read-only transaction. It discovers ledger schemas,
  checks all historical/forward checksums and statuses, hashes full history rows
  and sensitive logs, inventories schema metadata and aggregate predecessor
  counts, and rolls back. It cannot migrate, resolve/reset, clone, or mark an
  upgrade/merge accepted. Existing evidence is never overwritten.
- Five safety/history/secret-boundary audit tests passed. Gateway/schema/provider,
  collector and real-loopback HTTP suites passed with them: 32 tests total.
  After the final output-existence guard, the five audit tests passed again.
- Dedicated E10 CI runs these unit tests without dev secrets. The collector now
  includes the two audit sources. YAML branch/permissions/failure/secret-isolation
  checks, JavaScript syntax and whitespace checks passed.
- Historical migrations, runtime gateway/auth/receipt source and deployment
  workflows are unchanged in this review.

## External attempts and result

The gh request to list E10 runs failed at the socket with a Windows network
access denial. gh also reported an invalid stored token, but that cannot establish
credential validity while connectivity is denied. No re-authentication or token
replacement was performed.

gcloud could identify a configured account locally. The dev-only Secret Manager
attempt failed. The audit stopped before connecting to PostgreSQL; its immutable
blocked receipt is tools/explore-e10/.runtime/dev-merge/dev-baseline-attempt.json.
It contains source/checksum inputs and a prerequisite failure, not live ledger or
schema results. No credentials, raw cloud output or DB errors are in that receipt.

Hosted validation of the exact final source and verification/rehearsal against
actual dev lineage therefore remain blocked by external access. A green old run,
synthetic snapshot or disposable bootstrap cannot close either gate. Original
hosted runs and artifacts remain preserved.

## Continuation

See [dev merge checks](../tools/explore-e10/DEV_MERGE_GATES.md) for the prepared
commands. Use an authorized environment with GitHub and dev Secret Manager/DB
connectivity. Verify the remote head before a normal feature-branch push, collect
its exact-source hosted receipt, and run the read-only dev inventory to a new
file. If compatible, rehearse the pending forward migrations through the actual
lineage on an authorized isolated clone, retaining all genuine history rows.
No automatic baseline adoption, historical rewrite or resolve is authorized.

The app is validated separately with its two local dev changes included; its
report records the final full-suite and analysis results. Device acceptance and
the diary follow a future default-off dev merge. Delivered-data retention/erasure
remains an activation gate for queue diagnostics. No Docker, local DB server,
install, native build, generation, flag activation or deployment occurred here.
