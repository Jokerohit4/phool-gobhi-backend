# Parent review: actual dev lineage rehearsal, 24 October 2026

Access was restored. Backend source 63f5662 was pushed and tested in hosted run
40105785508. Gateway/diagnostic checks and all five native database lanes passed;
raw fresh/old historical replay still failed as before. Original artifacts are
preserved. This is separate from the next captured-dev lineage candidate.

## Read-only dev findings and classification correction

The actual dev URL selects public._prisma_migrations, shared by all services.
There are 143 complete rows. All 36 auth historical migration names have
successful entries with source-compatible checksums. The three earlier rolled
back attempts have later successful entries; none is an unresolved failure.
104 successful foreign-service rows are verified against their own source.
Two old health checksums match committed historical versions 6bebbe69 and
5a18b93c; their source proofs are recorded rather than silently ignored.

The initial generic audit incorrectly treated shared-service rows as unknown and
superseded attempts as open failures. The corrected classifier recognizes only
checksum-verified foreign entries and a later checksum-verified success for a
retired attempt. Unknown, unverified, unfinished, missing and duplicate successes
still block. No live ledger row was changed, resolved, removed or rewritten.

Actual predecessor objects exist, and Explore tables are absent. Aggregate counts
are 129 auth users and one legacy collectible. The founder's documented
unreleased-collectible replacement waiver remains applicable; no live row has
been deleted by this audit/capture.

## Authorized additional hosted evidence class

The parent adds a metadata clone of the actual dev auth schema and the complete
shared ledger, including every original field. Account data is synthetic. This
is distinct from rebuilding old SQL from empty and from the approved generic
parent snapshot/bootstrap. No claim is made to clone actual account records.

Capture uses a repeatable-read/read-only connection, a read-only Prisma schema
diff with default_transaction_read_only enforced in its separate connection,
and before/after history/schema checks. It captures auth-only schema SQL, full
migration rows, sequence metadata and aggregate counts; no account records or
DB URL. Credential-shaped diagnostics are refused. History precision is retained
through PostgreSQL to_jsonb, not JavaScript Date conversion.

The 25,672-byte compressed/base64 metadata package is passed through a newly
created temporary GitHub secret EXPLORE_E10_DEV_LINEAGE_FIXTURE. It contains no
DB credentials and no account records. It is not committed or uploaded as an
artifact. The owned rehearsal receives the metadata only, cannot connect to
live databases, and emits only history hashes/provenance, synthetic counts and
redacted status. The temporary secret must be deleted after final execution.

The owned PostgreSQL lane restores the captured schema and 143 genuine ledger
rows, verifies every field matches, restores original sequence state, creates a
synthetic account/legacy find, and runs the ordinary current auth Prisma
migration directory. Acceptance requires exactly the three pending Explore
migrations, all original rows unchanged, intended legacy removal, and unchanged
non-legacy synthetic auth data/sequences. It then runs the same native
HTTP/receipt/telemetry/export/erasure suite as the other lanes.

## Scope

Historical migration files and runtime application source remain unchanged.
Raw replay failures remain visible and are not relabelled as passes. Existing-dev
merge readiness is evaluated using the captured existing schema/history lane;
new-environment bootstrap adoption and physical rollout acceptance remain
separate. This record does not by itself approve live migration execution.
