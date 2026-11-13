# Explore E2 rehearsal owner handoffs

2026-10-24. Historical provisioning diagnosis complete; explicit bootstrap proposal
requires parent review. Injected trigger failures should remain
`INTERNAL_ERROR / 500 / retryable=true`. No production classification change is
justified. Native rollback and provisioning acceptance remain hosted gates.

## Isolation and original evidence

Inspected existing worktrees before creation. The requested path and branch were
absent. Created `C:/Users/rohit/Phool-Gobhi/wt/backend-e2-rehearsal-fixes`, branch
`feature/explore-e2-rehearsal-fixes`, from exact
`5c18daf262a5d2941f5b4964d279d47ec9635e33`; verified clean branch/status before
editing. Git ownership exceptions are per-command, with no global config edit.

Read E10 report/evidence JSON, auth schema and migration history, routes/contracts,
setup/deployment documentation, Dockerfile history and frozen
`explore-world/docs/explore-contracts/api.md` and error fixtures. No applicable
AGENTS.md was found in checked ancestors or this repository. Dependency reuse is
an ignored junction to E10's existing auth node_modules; no install, generation,
build, Docker or native DB execution occurred locally.

Original hosted inputs were read only at
`C:/Users/rohit/Phool-Gobhi/wt/backend-e10/tools/explore-e10/.runtime/hosted/40057075433`:
verification JSON, extracted historical/native logs, original archive and recorded
proposal. E10 evidence identifies run `40057075433`, tested source
`2bb36125e65d5b431b8557b94152296e6b889ce7`, conclusion **failure**. Archive SHA-256:
`54d773af7537bd0941d60508df2f4969e2f2da2f90391ec606de408a7c65726e`.
The original report, evidence JSON, harness, workflows, archive and logs are unchanged.

## Historical provisioning root cause

The first three migrations create unqualified `User`, enum and obsolete wallet
objects. They contain neither `CREATE SCHEMA auth` nor a table/type transfer.
The fourth, `20260704000000_add_user_onboarding_fields`, immediately creates
`auth.Gender` and alters `auth.User`. Both original hosted chains failed with
P3018 / SQLSTATE 3F000 at that transition. A later migration cannot run before
that failure, so adding a tail migration cannot fix raw replay.

Git history establishes the omitted provisioning convention:

| Source | Recorded transition absent from migration SQL |
| --- | --- |
| `54172708428a231f358c09cc7070515daab378a8` | Removed Wallet/WalletTransaction/wallet/transaction models from auth schema; their historical creation SQL remains |
| `bcb62c6dc7f9f6299e8dc19b77863cb08280901a` | Introduced multiSchema and `@@schema("auth")`, phone and nullable email/password; Docker startup changed from migrate deploy to `prisma db push --accept-data-loss` |
| `02f90de8e3674f971f52ac07d540371a637fbe5c` | Added User.profileImageUrl/fcmToken through schema changes |
| `9b776d15e3b32cc2e858b273636238117ae71eb6` | Added User.isActive and PitchAccessContact/PitchContactType without creation migrations |
| `1f52f842e34a8623b325966b9534fcc050f110bc` | Added SavedAddress through schema; July 17 migration assumes the table already exists |
| `2fffbe72cb2a73e9eceeacce1279488d79cf25bd` | Removed startup db push from the Dockerfile |

This proves source/deployment reliance on schema synchronization, not which SQL
actually ran against any live database. It does not establish whether historical
data was moved, copied or recreated. Do not infer a safe public-to-auth data move
from the schema annotations. `CREATE SCHEMA auth` alone still lacks auth.User;
putting the first three migrations under auth still omits phone/profile/address/
pitch changes and retains obsolete wallet objects. Neither is a complete repair.

Current `deploy/README.md` records one DB per environment, schema per service;
its statement that init migrations create schemas does not hold for auth's old
chain. `.github/workflows/deploy.yml` now runs `prisma migrate deploy`; auth's
current Dockerfile only starts Node. `SETUP_DATABASE.md` documents old db-push and
resolve/reset recipes. Added a pointer there so those recipes are not mistaken
for approval to recover this failure. Deployment workflows remain untouched.

## Reproducible provisioning proposal for parent review

These are three different evidence classes:

1. **Raw historical replay:** run all unchanged migrations from empty. It failed;
   retain that receipt. This change does not repair it or waive the gate.
2. **Explicit bootstrap:** render and execute a pinned schema snapshot on a
   verified empty, disposable database. This creates schema state, not historical
   execution evidence.
3. **Schema baselining:** record the identity of an inspected schema state as a
   baseline for future migrations. This is an adoption decision, not evidence
   that each old SQL file executed. Never resolve failed migrations implicitly.

The narrow reproducible fresh strategy is the already rehearsed parent snapshot
plus the exact three forward migrations, with its history accurately labelled.
Parent approval must explicitly replace the fresh-replay acceptance expectation
with bootstrap/baseline acceptance. Without that decision the gate stays failed.
No speculative historical data-transfer SQL or production bootstrap was added.

`tools/explore-e2/provisioning-inputs.mjs` prepares review inputs using Git objects,
not mutable working files. Run from the isolated worktree:

```powershell
New-Item -ItemType Directory -Path tools/explore-e2/.runtime -ErrorAction SilentlyContinue
node tools/explore-e2/provisioning-inputs.mjs tools/explore-e2/.runtime/provisioning-review
```

It refuses any existing output directory. The package contains exact parent
`5214fa8dd8242093e542bd89a169dcf9321753b2` schema, 36 historical SQL files plus
migration lock, three candidate forward SQL files, and a deterministic SHA-256
manifest. It also verifies every parent historical file equals the requested
candidate's Git bytes. It never reads a DB URL, invokes Prisma, contacts a DB,
writes migration history or changes a source migration. Historical files in the
package are audit inputs, not an executable deployment directory.

Generated review package locally at the ignored path above: **41 files** plus
manifest, manifest SHA-256
`729d0e68ff39f2af237192023d9353feb8f2244a2f0e3def996c702597378b55`.
No SQL was rendered or executed. The package can be reproduced from pinned Git
objects without relying on ignored local output.

Proposed hosted implementation after review:

1. In a new owned empty DB, use locked auth Prisma **6.8.2** to render
   `migrate diff --from-empty --to-schema-datamodel <package>/parent.prisma --script`.
   Preserve SQL bytes/hash, tool version and package manifest. Review generated
   SQL for auth-only scope and required tables/enums/indexes/FKs/defaults. No
   current-schema snapshot: it would include Explore and collide with forward SQL.
2. Stage a separate schema/migration directory with the copied PostgreSQL lock
   and a single baseline `00000000000000_e2_parent_5214fa8_schema_bootstrap`.
   Its migration.sql contains the rendered SQL wrapped in BEGIN/COMMIT. Run
   locked Prisma migrate deploy against that staged schema and a verified empty
   DB, so the baseline is actually executed and tracked with its own checksum.
   Verify empty predecessor schema, including CollectibleFind. Do not execute
   the SQL twice or manufacture 36 applied historical rows. Preserve the
   checked-in historical directory unchanged.
3. Run exact forward SQL in order: `20261023000000_exploration_core`,
   `20261023000100_drop_unreleased_collectible_find`,
   `20261023170000_explore_receipt_telemetry`. Add those exact directories beside
   the staged baseline and run migrate deploy again against that staged schema;
   retain real success/failure history. Include core triggers
   and SQL-only CHECKs from these files, not schema diff substitutes.
4. Rehearse empty and populated predecessor states. Populate User and legacy
   CollectibleFind before upgrade; verify intended legacy removal, unaffected
   auth data/sequences and complete pre-existing history rows unchanged. Run
   native Explore/telemetry suites and verify cleanup.

This new baseline lineage is a **proposal**, not operationally wired. The current
deployment workflow uses the original migration directory and would try its old
pending migrations on this new lineage. Parent/schema/deployment owners must
review lineage selection and future migration delivery before using this strategy
outside disposable CI. Do not aim that workflow at a newly baselined DB yet. This
task does not modify workflows or authorize production use. The existing E10
snapshot history is evidence of snapshot upgrades only; it does not validate this
proposed new Prisma baseline lineage.

For an **existing database**, preserve its lineage and data:

- On an isolated hosted clone, inventory auth/public objects and every discovered
  `_prisma_migrations` table, including every field/checksum of all rows; compare
  against the frozen parent schema and historical files. Capture constraints,
  triggers, indexes, enum values, sequence ownership/values and relevant row counts.
  Do not select a history table solely from a guessed search_path.
- If it already matches the parent prerequisites and has successful historical
  history, apply only pending exact forward migrations through its existing
  executor/lineage. Compare all original rows byte-for-byte afterwards. This is
  the unchanged-history upgrade gate; it has not yet run successfully in E10.
- If schema was pushed without history, adopt a distinct baseline only after
  owner-approved schema comparison and lineage-delivery design. Retain any
  existing history; do not replace it with E10's synthetic table or auto-resolve
  all historical names. A clone with genuine history is still needed to prove
  preservation of applied historical rows.
- If history contains a failure, stop and inspect partial effects. Preserve the
  row/logs. On disposable failed replay DBs, create a different DB for bootstrap;
  leave failed evidence intact. For an actual existing DB, backup and a reviewed
  per-failure recovery plan are required before any explicit resolve operation.
  No general `--applied`/`--rolled-back` recovery is supplied here.

## Native failure classification

The claim and outbox injections in E10 use plain `RAISE EXCEPTION` without
ERRCODE. PostgreSQL 16 defines the default as `raise_exception` / `P0001`, a
generic exception, not evidence of connection loss or temporary storage outage.
See [PostgreSQL 16 errors and messages](https://www.postgresql.org/docs/16/plpgsql-errors-and-messages.html).

`routes.js` preserves typed ExploreError codes; exceptions with a Prisma P-code
map to WORLD_UNAVAILABLE; remaining exceptions map to INTERNAL_ERROR. There is
no error logging or raw diagnostic serialization. The observed 500 and source
are consistent with Prisma's unknown request error without a Prisma `.code`.
Original artifacts intentionally contain no raw exception shape, so that exact
runtime class is an inference, not a captured native diagnostic. PostgreSQL
SQLSTATE P0001 and Prisma client P-codes are different namespaces; do not attach
SQLSTATE as `.code` to invent an outage classification. The existing broad
Prisma-P-code policy is retained; this task does not redefine every Prisma error.

The appropriate expectations for these injections are exactly:

| Failure | HTTP / error code | retryable | Retry-After |
| --- | --- | --- | --- |
| Generic trigger/unknown exception | 500 / INTERNAL_ERROR | true | absent |
| Known storage reachability/timeout/pool exception (tested P1001/P1002/P1008/P1017/P2024 shapes) | 503 / WORLD_UNAVAILABLE | true | 5 |
| Explicit typed world unavailability | 503 / WORLD_UNAVAILABLE | true | 5 |

Both transport errors are explicitly permitted by the frozen API. Retrying the
unchanged claim remains allowed; a 500 does not make a claim terminal or prove
it rolled back. DB rollback checks and recovery/replay checks are separate proof.
No response may disclose SQL, table/error metadata, proof, location or PII. Exact
response keys must be only `{error:{code,messageKey,retryable,requestId}}`, with a
fresh nonempty server request ID. The app retains queued proof on retryable
failure. No production route, contract, telemetry or retry behavior changed.

## Exact E10 owner handoff (not applied to E10 files)

For `tools/explore-e10/postgres.test.mjs` claim failure and
`tools/explore-e10/telemetry-postgres.mjs` outbox failures, recommend these exact
assertions after collecting each HTTP response. First extend E10's request helper
return to include `retryAfter: response.headers.get('retry-after')`.

```js
assert.equal(response.status, 500);
assert.match(response.body.error.requestId,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
assert.deepEqual(response.body, {error: {
  code: 'INTERNAL_ERROR', messageKey: 'explore.error.internal_error',
  retryable: true, requestId: response.body.error.requestId,
}});
assert.equal(response.retryAfter, null);
```

Collect the claim response and both outbox branch responses (saved user 23,
rejected user 24). Run rollback queries before envelope assertions, and collect
both outbox responses before asserting either status so one status failure does
not prevent the other injection. For each user require zero rows in
`ExploreLocationReceipt`, `ExploreProgress`, `ExploreClaim` **and**
`ExploreReceiptEvent`. The original claim test omits ExploreClaim; add it.
Keep trigger cleanup in finally. After removing the fault, retry the identical
commands: claim/saved branch must save once, then replay `already_saved` with the
same receipt and no extra revision/event; rejected branch must return its terminal
FIX_INACCURATE rejection, then replay it without an extra outcome/event. This
closes rollback/retry semantics, rather than merely accepting a 500.

Keep a separate known-outage 503 assertion, with the same exact envelope check
but WORLD_UNAVAILABLE / explore.error.world_unavailable and Retry-After 5.
The local route regressions cover substituted exception shapes. A real native
connection-failure case, if required for acceptance, must be a separate hosted,
owned disposable fault; generic trigger exceptions are not that proof. Do not
change the injection to masquerade as a network outage.

The existing E10 timeout patch remains an independent parent review item: use
stable originalUrl rather than router-relative req.path and validate actual
client timeout/replay on hosted CI. The archived proposal retains 503 assertions;
these classification recommendations supersede only those assertions after owner
review. Neither the archived proposal nor any E10 harness file was edited.

For provisioning, E10 must continue recording raw replay failures independently.
Add an explicitly labelled bootstrap/baseline lane only after parent approval of
the changed expectation; include source/tool/SQL hashes and complete history
before/after. Snapshot success must never set the raw historical-replay result to
passed. Original failed run receipts remain unchanged.

## Implementation and local validation

Owned changes: this report; SETUP_DATABASE.md pointer; expanded
`services/auth-service/test/exploration.test.js`; offline review exporter and its
test/ignore under `tools/explore-e2`. The exporter is an owned provisioning
preparation artifact, deliberately without an automatic database mutation path.

- Node v24.16.0, `node --experimental-test-module-mocks --test
  services/auth-service/test/exploration.test.js`: **81 passed, 0 failed, 7 existing
  skips** (B1/E4 delegated cases). Eight exception cases cover all four routes,
  full envelope, UUID, retry header and absence of console log/warn/error output.
  These use real loopback HTTP and substituted DB/error shapes, not native DB proof.
- `node --test tools/explore-e2/provisioning-inputs.test.mjs`: **1 passed**, verifies
  deterministic exact-byte package/hash output and refusal to overwrite an
  existing directory. Uses only Git/filesystem and a cleaned temporary directory.
- `node --check` for the exporter, its test and exploration.test.js: passed.
- `git diff --check`: passed. `git diff --exit-code 5c18daf --` for auth Prisma
  and exploration source, tools/explore-e10, .github and original E10 report/
  evidence: empty. Original archive hash still matches the receipt above.
- All 14 vendored transport error examples structurally match the read-only
  frozen packet.

Remaining gates: parent acceptance decision on bootstrap vs historical replay;
hosted execution of approved bootstrap lineage and existing-history upgrade;
hosted rollback/envelope/retry proofs for all three injections; independent
timeout fix/replay proof; separate real outage proof if required. E10's integrated
app, sink/runtime, E8 and E11 gates remain with their owners. No shared DB access,
workflow edit, push, merge, deployment or historical migration rewrite occurred.
