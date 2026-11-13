# Explore E10 backend candidate and migration rehearsal

2026-10-24. **Latest hosted run: raw historical replay failed; both snapshot/bootstrap upgrades and all five native suites passed. Cleanup passed.**
Tested source is `7915189104fa8559c32ee487f7491b9e73c4ac56`, run 40077401208.
The raw historical, genuine-history-preservation and production-lineage gates
remain open; scoped bootstrap/native passes do not waive them.
This is not an Increment A acceptance receipt. Full E10 also awaits the integrated
app, actual generator implementation/device evidence and E11 acceptance. No merge
to dev/parent, deployment, shared flag change or external message occurred. Only
the exact reviewed candidate was pushed to its feature branch as recorded below.

## Source identity and isolation

| Input | Exact identity |
| --- | --- |
| Approved backend core | `0db69a2496f9fd46afd5037dffd4640250f00990` |
| Approved E4 | `199337004f88464f374fc387800b67bd75926059` |
| Approved E10 CI preparation | `6198594243847b1c52861db8272b133b28a20e8b` |
| Approved E2 rehearsal handoff | `c9f95f39caf40d89c5a6a2ad81f9f31f0b99a984` |
| E2 cherry-pick on current candidate | `dd95019ef37b14687e175ccbca613b8fac70b92f` |
| Approved backend receipt telemetry | `c2f0c81a2dccc4896f09a2bb522807ffeaf35314` |
| Telemetry cherry-pick in combined candidate | `4a5d136c52149e4c920010600d4a6e1d4ec7a419` |
| E4 cherry-pick on candidate | `1b221610b204c5bcf97e08dd041b6a61c82c2941` |
| Parent schema used for optional snapshot baselines | `5214fa8dd8242093e542bd89a169dcf9321753b2` |
| Read-only app/contract checkout HEAD during inspection | `393789532448f3c5e97f561822ae03291d8941f1` |
| Candidate | `C:/Users/rohit/Phool-Gobhi/wt/backend-e10`, `feature/explore-e10-backend` |

The approved preparation checkpoint is
`a8da057d808a84a5155bdd2141dab02e82462c2c`; its parent is the E4 cherry-pick
above. Later session checkpoints update this report without changing those inputs.

Inspected existing worktrees/branches first. Neither requested path nor branch
existed. Created a new worktree at the approved core, verified the branch and
clean status, then cherry-picked E4 without conflicts. Per-command
`-c safe.directory=<repository>` handled sandbox ownership without global config
changes. Source core/E4 worktrees remain clean and at their approved SHAs.
The main backend checkout's unrelated dirty deploy/health files were left alone;
the main app checkout was only read for its existing Dart package configuration.
Ignored dependency junctions exist only in the new candidate and were used
read-only; isolated generated clients went into `tools/explore-e10/.runtime/`.

Creation/integration commands (with the corresponding repository-specific
`-c safe.directory=...` on each Git invocation):

```powershell
git -C C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend worktree list --porcelain
git -C C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend branch --all --verbose
git -C C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-backend worktree add -b feature/explore-e10-backend C:/Users/rohit/Phool-Gobhi/wt/backend-e10 0db69a2
# Remaining commands run from the candidate worktree:
git status --short --branch
git cherry-pick 1993370
```

Read the Explore plan (including the founder's legacy-check waiver), frozen packet
README/baseline/API/fake-server/lanes and JSON fixtures/reference, E9 handoff and
the core exploration README. No applicable AGENTS.md or CLAUDE.md was found in
the repository or checked ancestor locations. The explicit E10 ownership in this
request permits the new artifacts and backend registry handoff; production
authority remains with the source owners.

## Validation actually executed

This table records the original preparation before the telemetry integration.
Current combined-candidate tooling checks and unexecuted DB gates are recorded
in the combined preparation section below.

Commands below run from the candidate root unless another directory is named.
Node was `v24.16.0`; Prisma client/CLI was `6.8.2`. Logs are ignored local files;
their SHA-256 values and summaries are in `explore-e10-backend-evidence.json`.

| Command | Result | Evidence class |
| --- | --- | --- |
| `node --experimental-test-module-mocks --test test/gateway.test.js` | 19 passed | Gateway middleware/ingestion tests, substituted dependencies |
| In `services/auth-service`: `node --experimental-test-module-mocks --test` | 889 tests: 875 passed, 14 skipped, 0 failed | Generator, real loopback router HTTP, memory Prisma and account-operation mocks |
| In `services/booking-service`: same command | 241 passed, 0 failed | Includes all 16 E4 endpoint cases; attendance DB substitutes |
| `node --experimental-test-module-mocks --test tools/explore-e10/http.test.mjs` | 1 integration scenario passed | Real loopback gateway proxy, JWT verification, auth/booking routers; memory DB, captured ingestion, loopback metadata |
| `node scripts/check-analytics-events.cjs` | 199 registered names, no backend drift | App/admin/website sibling scans skipped because their expected paths are absent |
| In read-only `explore-world`: `node docs/explore-contracts/tools/reference.cjs --check` | Three JSON artifacts verified; 440 complete spawns and primitive/radius/timing probes | Frozen reference, no DB |
| There: `C:/src/flutter/bin/cache/dart-sdk/bin/dart.exe --packages=C:/Users/rohit/Phool-Gobhi/repos/phool-gobhi-customer-app/.dart_tool/package_config.json docs/explore-contracts/tools/check_dart_parity.dart` | All 543 probes passed, including 440 full SHA-256 spawns | Independent Dart verifier, not the integrated app generator/device |
| `node services/auth-service/node_modules/prisma/build/index.js validate --schema services/auth-service/prisma/schema.prisma` | Valid | Schema only, dummy loopback URL |
| Same CLI: `migrate diff --from-empty --to-schema-datamodel services/auth-service/prisma/schema.prisma --script` | SQL rendered | No DB execution |
| Same CLI: `generate --schema tools/explore-e10/.runtime/auth.prisma` and `booking.prisma` | Both clients generated into isolated `.runtime/*-client` | No DB execution; schemas copied with only generator output changed |
| `node --check tools/explore-e10/rehearse.mjs` and `postgres.test.mjs` | Passed | Syntax only |
| `git diff --exit-code 0db69a2 -- services/auth-service/prisma` | Empty, exit 0 | Schema and every historical/new migration unchanged from approved core |
| `git diff --exit-code 1993370 -- services/booking-service/controllers/bookingController.js services/booking-service/services/bookingService.js services/booking-service/test/visitedGyms.test.js` | Empty, exit 0 | Exact approved E4 implementation |

Auth's 14 skips comprise four B1 cases, three E4 fixtures intentionally delegated
to booking tests, and seven absent customer/admin checkout parity checks. They
are not claimed as passes. The historical 35-test app host baseline was not run
by this backend task and remains an integrated-app gate.

The combined HTTP test proves missing/invalid/expired JWT rejection, partner
denial, stripping forged account headers, account-separated history, saved replay,
E4 v1/v2 routing, cross-source IST-day deduplication, namespace separation,
missing venue metadata retention and nine-name ingestion/server-name exclusion.
JWTs are locally signed fixtures; login/OTP issuance and Cloud Run IAM are not
exercised. The existing core suite additionally passes mock-backed catalogue
change/delayed first claim, timeout replay, timing, pagination, transaction
rollback, export/deletion and flag-off queue/history tests.

Vendored JSON equals the frozen packet structurally and byte-for-byte after
CRLF-to-LF normalization. Raw Windows checkout hashes differ only by line ends.
LF file SHA-256 values:

- catalogue: `58dd5c975d8da5bc9329d2fc447fec0f6ee6d60f4e0cffbe9e2c5b9e020b9e4b`
- generator fixtures: `196805f155537988c09b623cf024a87224fa34c49f0fab2314a24ff9fe3bcc27`
- API fixtures: `be263ad7807637839cb5810b94c23986a26d8a1249187141513c9838acad3455`

Catalogue content binding:
`sha256:873d7b2a83f3916a1779e3dc0e0b4687e69d35190b22a8fc64763706658734f3`.
Empty drop/region binding:
`sha256:7c1c988c3a72e72eeb69f97ec43679aa0e345777980c371ce05b18c37d81980a`.

## Registry handoff and production-owner actions

`docs/analytics-events.json` now registers all nine E9 names as `source=client`,
`apps=[phool_gobhi]`, using the existing registry format. The three authoritative
saved/rejected/daily-set names are reserved as `source=server`,
`service=auth-service`; none enters the gateway client allowlist. Historical
`map_explored_opened` and `badge_shelf_viewed` entries retain their meanings.
Registry notes describe coarse fields only; they are documentation, not a new
gateway property validator. E9's app sanitizer remains responsible for its payload
contract. No synthetic event was sent to a real analytics sink.

**Historical handoff to E2/E9 (superseded by the combined candidate below):** the then-approved `exploration/service.js` had no receipt-event
adapter/call sites. Registration does not implement authoritative saved/rejected
emission, durable delivery or receipt-deduplicated analytics. Those owners must
provide the scoped implementation and replay/concurrency evidence before E10 can
claim the saved funnel. Daily-set emission remains B1. No production emitter was
silently added here. This report is the local owner handoff; no external messages
were sent.

**Handoff to E2:** the core README's production verification TODO is stale relative
to the founder waiver in the plan/baseline. That documentation discrepancy does
not reinstate the waived approval requirement. Fresh-chain failures, if exposed
by a later real run, belong to the migration/schema owner; do not edit historical
migrations or mark them resolved to make this candidate pass.

## Migration and rollback evidence, with limits

Executed `Get-Command psql,postgres,pg_ctl,docker,node,npm`: PostgreSQL executables
were unavailable on PATH. `docker info --format '{{.ServerVersion}}'` failed:
the `docker_engine` named pipe does not exist; Docker also reported denied access
to its config. Then executed `node tools/explore-e10/rehearse.mjs`; it exited 1
at that same prerequisite, created no container/database and recorded
`cleanup=no container created`. The exact redacted blocked receipt is included
in the evidence JSON. No migration was applied anywhere.

The reproducible runner and its prerequisites are documented in
`tools/explore-e10/README.md`. It uses only its own random Docker container,
loopback port, random local password and five disposable DBs; no caller-provided
DB URL, inherited service secret, image pull or shared infrastructure is used.
The exact historical chain is attempted unchanged. A separate old-chain run
populates CollectibleFind before forward deployment and compares every prior
applied migration row. Empty/populated parent-schema snapshot rehearsals are
explicitly separate, retain their accurately labelled baseline history, and apply
the exact two E2 forward SQL files transactionally. Schema snapshots are never
presented as historical migration replay.

The real HTTP/DB suite is prepared for runtime and both snapshot-upgrade DBs.
It checks native publication/claim races, immutable publication/receipt triggers,
unique/FK/terminal-outcome constraints, forced transactional failure, revision-pinned
pagination/account-bound cursors, original-manifest delayed first upload, rotation,
HTTP boundary/grace probes, real auth-local export/deletion and E4 DB recognition.
Its HTTP middleware holds the post-commit reply beyond a real client timeout,
then replays the command; it does not claim native database connection-failure
evidence. External export/erasure fan-out
and analytics remain substituted; gym metadata is a loopback HTTP fixture.
The harness is syntax-checked and its clients generated, **not runtime-validated**.

Prepared rollback switches issuance off while leaving bound catalogue/history and
pickup resolution online: confirmed receipt retained; eligible pending command
saves; expired pending command rejects terminally; unknown manifest remains a
typed retryable error without publication; saved replay after grace returns the
original receipt. Re-enabling retains receipts. No reverse migration, removed
queue API, legacy table recreation or legacy collectibles restoration is used.
This behavior passed the existing memory-backed flag-off test; the PostgreSQL
rollback rehearsal remains unexecuted.

Production Explore code writes only Explore records. E4 changes only the visited
projection. Current code review and mock-backed suites show no food, workout,
step, coin or One Plan score mutation. The prepared DB suite snapshots all
non-Explore auth/booking tables except the intentionally toggled flag setting and
checks for downstream mutation calls. Real health/wallet/food/score services and
integrated-app side effects have not been exercised, so no broader real-system
non-mutation claim is made.

## Remaining acceptance gates

1. Raw historical replay still fails in run 40077401208. Genuine historical
   applied-row preservation and production/deployment-lineage safety remain
   unproved. Snapshot/bootstrap and native successes do not replace those gates.
2. Backend native timeout, generic-fault rollback/recovery and receipt telemetry
   now pass on all five DBs for the exact tested candidate. Parent review and
   separate E8/E9 fixes/integrated-app payload and operating-sink acceptance remain.
3. Integrated app source/build/config identities, implementation-level Dart
   generator parity, current 35-test host coverage, DI/obsolete app-code removal,
   durable offline outbox/restart/account teardown and real app-to-backend journey.
4. Actual food/workout/coin/One Plan invariants across the integrated app/services,
   and E11 phone, location, accessibility and pilot gates. B1/B2 acceptance is not
   implied by this Increment A backend candidate.

## Continuation checkpoint: 2026-10-23, approximately 16:39 UTC

Verified `feature/explore-e10-backend` at approved preparation checkpoint
`a8da057d808a84a5155bdd2141dab02e82462c2c` with a clean tracked/untracked Git
status before work. The parent review supplied 656 relevant passing tests,
7 skipped, and successful registry/syntax checks. Those are attributed review
results, not new executions in this session; the earlier validation table remains
historical evidence from preparation.

Executed once from this candidate:

```powershell
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/wt/backend-e10 status --short --branch
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/wt/backend-e10 rev-parse HEAD
docker info --format '{{.ServerVersion}}'
docker image inspect postgres:16 --format '{{.Id}}'
```

Both Docker commands exited 1. The daemon's `docker_engine` named pipe was absent;
Docker also reported denied access to its config file. The image cannot be
verified while the daemon is unavailable; this is not evidence that the image is
missing. Following the requested prerequisite stop, **the rehearsal was not run**.
No container, volume or database was created, and no cleanup action was necessary.
There are no new migration/HTTP/DB check results or cleanup receipts to inspect.
No passing mock, registry or syntax suite was rerun. No harness or production code
was changed, and no E2/E9 or app commit was supplied or incorporated.

Tool identities at that checkpoint (raw file SHA-256; Git blob identities are also
recorded in the evidence JSON):

- `tools/explore-e10/rehearse.mjs`:
  `aa376f893108db4b3f8368c30ccf358dc2ccf3c9f93eb634bc7cbdb007a783b2`
- `tools/explore-e10/postgres.test.mjs`:
  `6814ed4a2cb26531171e8ebefdd322c5d5b2e9ec40a0fd6932e8c208980c4d92`

All PostgreSQL acceptance checks remain unexecuted: fresh historical chain,
populated historical upgrade with applied history retained, labelled empty and
populated snapshot upgrades, native concurrency/timeout/account isolation,
manifest-bound delayed first claim/rotation, export/deletion after drop, and
receipt-preserving rollback with pending resolution. The separate E2/E9 telemetry
and integrated-app acceptance gates remain open. This continuation commits only
the report and evidence JSON. Source lanes, shared infrastructure and historical
migrations remain untouched; nothing is merged, pushed or deployed.

## Runtime restoration attempt: 2026-10-23, 16:59 UTC

Resumed `feature/explore-e10-backend` at the exact requested checkpoint
`098f852e482b13d84fdc722d01d240cc2c3a74df`; initial tracked/untracked status
was clean. Read this report, the harness README, `rehearse.mjs` and
`postgres.test.mjs`. No passing mock suite was rerun. Tool source identities
are unchanged from the prior checkpoint: runner blob
`88a3168f9e891134fd017e27e877f7ea70a4477e`, PostgreSQL suite blob
`aae8e87a58fa0ea15690521efbd7b4f7d3089068`; full raw SHA-256 values and
commands/outcomes are recorded in the new evidence continuation entry.
Node is `v24.16.0`, Docker CLI `29.6.1` (build `8900f1d`), installed Desktop
`4.81.0.232925` at `C:/Program Files/Docker/Docker/Docker Desktop.exe`.

Inspected the existing installation and runtime. Desktop was not running;
`com.docker.service` was Stopped/Manual, while `vmcompute` and `WSLService`
were running. `docker context ls` could not read Docker config/context metadata;
`wsl --status` and `wsl --list --verbose` returned
`Wsl/EnumerateDistros/Service/E_ACCESSDENIED`. Executed:

```powershell
Start-Process -FilePath 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -WindowStyle Hidden -PassThru
docker info --format '{{.ServerVersion}}'
Get-Content -LiteralPath "$env:LOCALAPPDATA\Docker\log\host\com.docker.backend.exe.log" -Tail 55
docker --host npipe:////./pipe/dockerDesktopLinuxEngine info --format '{{.ServerVersion}}'
Start-Service -Name com.docker.service
Get-Service com.docker.service
git diff --exit-code 0db69a2496f9fd46afd5037dffd4640250f00990 -- services/auth-service/prisma
```

The hidden launch created Desktop PID 23912 and backend processes 24508/7064.
The startup log at `2026-10-23T16:59:51.833610000Z` reports **backend crashed**:
credential-helper initialization cannot read
`C:/Users/rohit/.docker/config.json` (Access is denied), and settings initialization
cannot read `.docker/daemon.json` (Access is denied). It also reports failure
saving settings and initializing CLI configuration. Both default `docker_engine`
and explicit `dockerDesktopLinuxEngine` probes exited 1 with absent named pipes.
`Start-Service` could not open `com.docker.service`; the service remains stopped.
This is a concrete startup/permission blocker, not a PostgreSQL assertion failure.
No ACL, Docker configuration or context was changed. No privilege escalation,
installation, reset, WSL shutdown or unrelated resource deletion was attempted.

**Required action:** outside this restricted agent session, start Docker Desktop
as the normal Windows user with access to the existing `.docker/config.json` and
`daemon.json`, resolve any startup prompt, and verify `docker info` succeeds.
If Desktop requests its Windows service, an administrator must run
`Start-Service com.docker.service`. The service denial alone does not establish
that the service is required for this WSL-backed installation. Then run
`docker image inspect postgres:16`; if absent, `docker pull postgres:16` is
authorized for this disposable rehearsal. Resume with
`node tools/explore-e10/rehearse.mjs` from this branch/checkpoint.

Stopped after the fatal startup diagnosis instead of repeatedly probing the
unchanged blocker. Image availability remains **unverified**, not missing;
no image was pulled. The rehearsal was not invoked because its daemon prerequisite
is known unavailable. All fresh-chain, populated historical upgrade/history,
labelled empty/populated snapshot, real HTTP/DB concurrency/timeout/account,
manifest/rotation, post-drop export/deletion and rollback checks remain
**unexecuted**. No harness container, volume or DB was created; no harness cleanup
was required. Docker Desktop was launched, but unrelated runtime resources were
not stopped or removed. No harness or production defect has been established.
The schema/migration comparison above exited 0; historical migrations remain exact.

Only this report and the evidence JSON change in this continuation. Shared
DBs, source lanes and application flags remain untouched. E2/E9 telemetry and
integrated-app acceptance remain separate gates pending reviewed inputs.
E8 Part 2 starts after the credential fix is approved; E11 execution waits for an
accepted integrated E10 candidate. No merge, push or deployment occurred.

## Hosted runner preparation: 2026-10-24

Verified `feature/explore-e10-backend` clean at
`9686c23091ab68b42cdc701d744a12d878909b93` before editing. Read the existing
workflows (including deployment triggers/permissions/DB job), report and harness.
The laptop Docker limitation supersedes the earlier local-start instructions;
Docker/build/DB execution must stay off this laptop. No Docker command, package
installation, Prisma generation, build, rehearsal or CI dispatch ran this session.

Added only `.github/workflows/explore-e10-postgres.yml`: Ubuntu 24.04, Node 24,
read-only `contents` permission, no persisted checkout token, cloud credentials,
service environment or deployment dependency. Push trigger is restricted to
`feature/explore-e10-backend`; a matching job ref guard also constrains manual
dispatch. Full-history checkout and explicit `git cat-file -e` verify the frozen
parent schema. That parent is an ancestor of the current candidate (verified
locally). Locked root/auth/booking installs use runner-owned directories; the
workflow pulls `postgres:16`, records its ID/digests and runs the existing command.
Existing workflows remain byte-for-byte unchanged.

Narrow harness changes select a directory symlink on Linux (Windows retains its
junction), retain HOME in the filtered tool environment, record Docker server
version, and create the container before starting it so `finally` can remove a
created container after startup failure. The random name/label/password,
loopback-only random port, five disposable DBs, environment-file rejection,
no caller DB URL, exact historical migration bytes, labelled snapshot baselines
and real HTTP/DB assertion suite are preserved. The misleading comment preceding
the independent old-chain replay now correctly labels historical replay.
`postgres.test.mjs` itself is unchanged. No production/schema defect was fixed.

The harness now redacts all persisted subprocess logs, final receipt and console
receipt, not only the top-level error. `redact.mjs` removes the known random
password, DB URIs, bearer/JWT tokens and synthetic fixture secrets. New
`ci-evidence.mjs` collects an explicit file allowlist, reapplies redaction and
records exact source/tool/log identities. Generated code, schemas, dependencies
and environment files cannot enter this artifact through a directory wildcard.
Bash pipefail and explicit command chaining preserve failures; `always()`
collection/upload does not turn a failed prerequisite/rehearsal green. A missing
receipt is explicitly marked unavailable. Forced runner loss/cancellation can
prevent cleanup/upload; only a reviewed receipt can establish those outcomes.
The ephemeral hosted VM is not a shared database or source lane.

Validation executed locally (tooling only):

- `node --check tools/explore-e10/rehearse.mjs` and
  `node --check tools/explore-e10/ci-evidence.mjs`: passed.
- `node --test tools/explore-e10/redact.test.mjs tools/explore-e10/ci-evidence.test.mjs`:
  2 passed, 0 failed. Synthetic failure/no-receipt fixtures verify redaction,
  retained failure/cleanup fields, source hashes and exclusion of runtime assets;
  the temporary Git fixture was removed.
- Python/PyYAML BaseLoader parsing plus assertions: YAML structure, exact branch
  guards, Ubuntu/Node version, read-only permission, full checkout, lockfile
  presence, always-upload and absence of credential/deploy hooks passed.
- Git Bash `-n` parsed every workflow shell block; a synthetic grouped-command
  failure with `-eo pipefail` retained a nonzero exit through a pipe. No workflow
  Docker/install/rehearsal command was executed by this syntax check.
- `git diff --check`: passed. Comparison to approved core for
  `services/auth-service/prisma`: empty, exit 0. Existing workflow and production
  paths are unchanged.

This is **CI preparation only**, with no new PostgreSQL results or harness-owned
container/volume/DB cleanup claim. The report/evidence retain all prior local
blocker history rather than presenting it as a hosted run. Following parent
review, a separately authorized push to this feature branch supplies the first
execution path; manual dispatch requires default-branch registration as documented
in the README. No push, merge or deployment was performed here.

All real migration/HTTP/DB/export/deletion/rollback acceptance gates remain open
until the hosted receipt is executed and reviewed. E2/E9 telemetry and integrated
app acceptance still require separately reviewed inputs. E8 Part 2 waits for the
approved credential fix; E11 execution waits for an accepted integrated E10
candidate. Shared dev/production DBs, application flags and source lanes were
untouched.

## Combined backend/telemetry preparation: 2026-10-24

Started clean on the requested branch at exact checkpoint
`6198594243847b1c52861db8272b133b28a20e8b`. Read this report, the approved
`docs/explore-receipt-telemetry-report.md`, workflow and harness. Executed
`git cherry-pick c2f0c81a2dccc4896f09a2bb522807ffeaf35314`; it applied cleanly
as `4a5d136c52149e4c920010600d4a6e1d4ec7a419`. No source lane or main checkout
was edited. Production auth source/schema/tests are exact to the approved telemetry
input, with its original report preserved. No additional production fix is made.

The old date-prefix baseline selection would have leaked the new telemetry
migration into the pre-feature replay. E10 now reads every baseline migration and
lock file, byte-for-byte, from the frozen parent tree, writes a new isolated
old-chain directory per container, and records path/SHA-256 identities. Fresh
deploy and populated forward deploy include the telemetry migration; successful
deploys additionally verify all three forward migration records and the native
telemetry CHECK. Native history lookup discovers the one Prisma history table
in auth/public rather than assuming a search path. Populated forward failure gets its own redacted log and failed
receipt; a failed baseline leaves that forward check explicitly unexecuted.
Independent snapshot/runtime checks still proceed after historical deploy failure.
No migration is rewritten, marked resolved or skipped to manufacture acceptance.

Both accurately labelled snapshot baselines now apply core, legacy drop and
`20261023170000_explore_receipt_telemetry` in order. Their baseline history row
remains unchanged. Current-schema setup generates the updated auth client and
adds the SQL-only telemetry outcome CHECK extracted from the approved migration.
Snapshot clients execute the actual forward-upgraded schema; generated outputs
stay in the ignored runtime. The existing native HTTP timeout now asserts a
single outcome, and export/deletion tests include the outbox. Generic analytics
mocks remain; production dispatcher/adapter imports are retained before those
mocks by the new `telemetry-postgres.mjs` helper.

Eight prepared native telemetry subtests per runtime/snapshot DB cover:

- Separate auth/sink databases and backend connections, separate auth worker pools,
  and a repeatable-read sink default against production explicit READ COMMITTED SQL.
- Saved/rejected outcome creation with actual HTTP races, claim/receipt/revision
  linkage, replay after grace, different claim IDs, privacy and native SQLSTATE
  uniqueness/outcome constraints; conflicts/malformed/retryable commands add none.
- Native outbox-insert failure rolling back receipt/progress/claim on both terminal
  branches, plus concurrent actual sink inserts deduplicated by delivery identity.
- Native sink transaction failure/backoff/retry, injected lost reply after real
  sink COMMIT, native local acknowledgement failure/rollback, then one-row replay.
- Competing production workers with a deliberately held row and SKIP LOCKED, and
  real account export/deletion: PostgreSQL-observed blocked DELETE, outbox-first
  guard triggers, deletion before worker selection and other-account/global retention.

The sink is a sixth disposable database, `e10_sink`, in the same harness container,
with a distinct pg pool, fixture table and sequential reset between suites. The
production `deliverPickupBatch` and `insertReceiptEvent` execute unchanged SQL.
Provider selection, production TLS/sink configuration/permissions, `ensureTable`,
interval scheduling, remote fan-out and actual process/network loss remain
unexercised/substituted. Injected clock/faults and explicit next-attempt adjustment
make the native ordering/retry tests deterministic; no real scheduler or throughput
claim is made. Domain-fixture backlog is made due independently of the host date.
Sink rows retain the approved separate pseudonymous retention convention after
auth account erasure; this is not platform-wide analytics erasure acceptance.

CI collects `old-forward.local.log`, three `telemetry-<DB>.local.json` summaries
(eight planned checks; missing/incomplete is not passed), and existing PostgreSQL
logs/receipt. Source hashes now include the new tests/baseline utility, emitter,
adapter, lifecycle/schema and migration. Workflow permissions/triggers, failure
propagation, redaction, isolated credentials/resources and final container/volume
removal are retained. Existing workflows and booking source are unchanged.

Local validation only:

- `node --test tools/explore-e10/redact.test.mjs tools/explore-e10/ci-evidence.test.mjs tools/explore-e10/migration-inputs.test.mjs`:
  **4 passed, 0 failed**, no skips. These are tooling/fixture tests, not receipt
  mock suites or DB evidence. Temporary synthetic Git fixture removed.
- `node --check` for `rehearse.mjs`, `postgres.test.mjs`,
  `telemetry-postgres.mjs`, `ci-evidence.mjs` and the baseline utility: passed.
- Lightweight YAML/shell/ownership/source invariants and `git diff --check`:
  passed. Production auth matches `c2f0c81`; workflow/booking match `6198594`.
  The only migration added since `6198594` is the approved telemetry migration;
  all earlier migration bytes are unchanged.

No Docker command, DB execution, install, client generation or build ran locally.
No hosted run exists for this combined candidate yet; all PostgreSQL checks are
**unexecuted**, including the new telemetry assertions. E10 harness defects were
fixed within ownership; no executed production defect has been established.
Historical/schema failures belong to E2; emitter/dispatcher/sink or lifecycle
defects go to the backend receipt-telemetry owner (E2/E9 handoff), with original
assertions/logs preserved. E9 app inputs, actual sink/runtime operations,
integrated-app acceptance and E11 remain separate gates. E8 Part 2 waits for the
approved credential fix; E11 execution waits for an accepted integrated E10
candidate. Nothing was pushed, merged, deployed or changed in shared infrastructure.

Additional E10 paths in this continuation:

- `tools/explore-e10/rehearse.mjs`
- `tools/explore-e10/postgres.test.mjs`
- `tools/explore-e10/telemetry-postgres.mjs`
- `tools/explore-e10/migration-inputs.mjs`
- `tools/explore-e10/migration-inputs.test.mjs`
- `tools/explore-e10/ci-evidence.mjs`
- `tools/explore-e10/ci-evidence.test.mjs`
- `tools/explore-e10/README.md`
- `docs/explore-e10-backend-report.md`
- `docs/explore-e10-backend-evidence.json`

The approved cherry-pick adds exactly the 15 production/report/test paths listed
under **Exact intended paths** in `docs/explore-receipt-telemetry-report.md`.

## Authorized hosted execution attempt: 2026-10-24, 03:03 UTC

Verified branch `feature/explore-e10-backend`, exact approved HEAD
`2bb36125e65d5b431b8557b94152296e6b889ce7`, clean tracked/untracked status and
origin fetch/push URL `https://github.com/Jokerohit4/phool-gobhi-backend.git`.
There is no separate pushurl override. Read the latest combined E10 report and
dedicated workflow. User authorization covers publishing this exact SHA to this
feature branch and its dedicated PostgreSQL workflow; it remains valid. No dev/main
push, deployment workflow, merge or infrastructure action is authorized here.

The required remote inspection failed before publication:

```powershell
git ls-remote --heads origin feature/explore-e10-backend
gh auth status
gh api repos/Jokerohit4/phool-gobhi-backend --jq '{full_name: .full_name, default_branch: .default_branch}'
```

Git reported `Failed to connect to github.com port 443 ... Couldn't connect to
server`. The API probe reported `dial tcp 20.207.73.85:443: connectex: An attempt
was made to access a socket in a way forbidden by its access permissions.` This
establishes a session transport/permission prerequisite failure. `gh auth status`
also labelled the default account token invalid; credential validity cannot be
established until GitHub connectivity works. No credential was printed, changed
or removed. No further unchanged network probes were attempted.

Remote branch existence, tip and ancestry remain **unverified**. To preserve
remote work, no push was attempted, and no workflow was dispatched. No hosted
run can be identified from this session, so run ID/URL and tested SHA are null.
This does not establish that no run exists elsewhere. No hosted artifacts were
downloaded; artifact source identities, completeness, redaction and hosted cleanup
remain unverified. Old local preparation receipts are not treated as CI artifacts.

| Required hosted evidence | Actual outcome in this attempt |
| --- | --- |
| Fresh historical migrations | Unexecuted/unverified; no receipt |
| Populated historical upgrade and unchanged history | Unexecuted/unverified; no receipt |
| Empty/populated snapshot upgrades | Unexecuted/unverified; no receipt |
| Real HTTP/DB save/replay/concurrency/isolation/rollback | Unexecuted/unverified; no receipt |
| Original-manifest delayed first claim and rotation | Unexecuted/unverified; no receipt |
| Native telemetry creation/retry/dedup/workers/deletion ordering | Unexecuted/unverified; no receipt |
| Harness-owned cleanup | Unverified; no identified run |

There is no CI pass/fail assertion result and no established workflow/harness or
production/schema defect to patch. The earliest actionable cause is permitted
GitHub transport from the execution session, followed by verified authentication.
Use a session permitted to access `github.com:443` and `api.github.com:443`, verify
`gh auth status`, and authenticate only if still required. Then inspect the remote
branch and ancestry before publishing. Preserve any remote divergence instead of
incorporating unreviewed work or force-pushing. Publish the **approved SHA**, not
the later local report commit:

```powershell
git push origin 2bb36125e65d5b431b8557b94152296e6b889ce7:refs/heads/feature/explore-e10-backend
```

That command has not been executed. After publication, identify the run by exact
SHA, branch and `.github/workflows/explore-e10-postgres.yml`, then inspect its
original artifacts and every required check/cleanup field before acceptance.

The local preflight diagnostic receipt, copied from tool output rather than
presented as a hosted artifact, is ignored at
`tools/explore-e10/.runtime/hosted-preflight-20261024T030304Z.json`, SHA-256
`c719fb2df6c32b7a7aaa46f31bcf19117e1a3e1fdc7026a8cc3bf48cc1531012`.
Its structured contents and identity are retained in the evidence JSON. No
container, volume or database was created by this attempt; local cleanup was
unnecessary. Docker, DB execution, installations and builds stayed off the laptop.
This continuation changes only the report/evidence, committed locally with no
automatic follow-up push. All PostgreSQL, E9/integrated-app, actual sink/runtime,
E8 credential and E11 acceptance gates remain as previously recorded.

## First hosted execution receipt: 2026-10-24, 03:08-03:09 UTC

The user enabled full access and existing feature-branch/CI authorization was
resumed. Local branch/status were verified clean at report-only checkpoint
`320a7ac39805c69ef3f26ce2ce2c9b31f5f0e01a`; the approved executable source
remained `2bb36125e65d5b431b8557b94152296e6b889ce7`. `gh auth status` and the
repository API succeeded. Git required the known ownership exception after the
user-context change; only per-command `-c safe.directory=...` was used. No global
configuration or credential change was made. This supersedes the previous network
blocker; that preflight history is retained above.

`git ls-remote --heads origin feature/explore-e10-backend` succeeded with no ref:
the remote branch was absent. Executed only the authorized publication:

```powershell
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/wt/backend-e10 push origin 2bb36125e65d5b431b8557b94152296e6b889ce7:refs/heads/feature/explore-e10-backend
```

Push created the feature branch without force and excluded the report-only
checkpoint. Remote tip was checked again after execution and is still the exact
approved SHA. No dev/main ref, source lane, PR, merge, manual workflow dispatch,
deployment workflow or cloud/shared DB configuration was changed.

Identified and monitored [run 40057075433, attempt 1](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40057075433):
API identity confirms `event=push`, exact approved SHA/feature branch and path
`.github/workflows/explore-e10-postgres.yml`. Job `rehearse`, ID `120762297795`,
finished **failure** after 49 seconds. Checkout, Node setup, historical-input
verification, all locked installs and image acquisition passed. Rehearsal exited
1; `always()` collection/upload succeeded, preserving the failure status.

Hosted tool identities: Node `v24.21.0`, npm `11.19.0`, Docker `28.0.4` build
`b8034c0`; installed auth Prisma `6.8.2`, booking Prisma `6.19.3`. The harness
uses auth CLI `6.8.2` to generate both isolated clients. Image `postgres:16` resolved
to ID `sha256:066167ff39c2a612402ce99b734ea1cff92a9d1f2ac52f697a5f0384f0d88d6b`,
repository digest `sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97`.

Actual receipts, not just job status:

| Gate | Observed outcome |
| --- | --- |
| Fresh full historical chain (39 migrations discovered) | **Failed** at the fourth migration, `20260704000000_add_user_onboarding_fields`: Prisma P3018, PostgreSQL 3F000, schema `auth` does not exist |
| Frozen pre-feature historical chain (36 migrations discovered) | **Failed** at that same unchanged migration/error |
| Populated historical forward upgrade/history retention | **Not executed** because baseline deployment failed; no claim of retained historical applied rows |
| Populated parent-schema snapshot + all three forward migrations | **Passed**, baseline row unchanged and legacy table dropped |
| Empty parent-schema snapshot + all three forward migrations | **Passed**, baseline row unchanged and legacy table dropped |
| Runtime DB native suite | 18 leaf passes, 3 leaf failures |
| Populated snapshot DB native suite | 18 leaf passes, 3 leaf failures |
| Empty snapshot DB native suite | 18 leaf passes, 3 leaf failures |
| Telemetry subset in each native suite | 7 passed, 1 failed out of 8; none skipped |
| Harness cleanup | **Passed per receipt:** `explore-e10-a868c893b7ca` container and its volumes removed by `finally` |

Combined native totals are **54/63 leaf checks passed, 9 failed**, no skips.
Node includes the failed parent in each suite, so its raw totals are 66 tests,
54 passed and 12 failed. Telemetry's 21/24 passes are a subset, not extra tests.

All three native DBs passed JWT/role/spoof gates, cold immutable publication races,
next-window rotation, original-manifest delayed first claim after C2 publication,
same/different claim concurrency, receipt/revision uniqueness and account isolation,
HTTP proof/grace boundaries, native constraints/pagination, mixed-source attendance,
flag-off pending resolution/receipt retention, non-Explore snapshot invariants and
legacy removal/account export/deletion. They also passed telemetry save/rejection
creation/replay/privacy, separate auth/sink connections, actual concurrent sink SQL,
native sink failure/backoff/retry, sink-commit/local-ack ambiguity, competing native
workers and PostgreSQL-observed dispatcher/deletion ordering.

The same three leaf failures occurred on every DB:

1. **E10 timeout harness defect:** the expected client rejection did not occur;
   fetch returned in about 13ms. Source review diagnoses the hold predicate's
   mount-relative `req.path` during nested `/explore` routing; that path is
   `/pickups` inside the router. The proposed stable `req.originalUrl` predicate
   still needs hosted validation; request paths were not logged. Timeout/replay
   assertions were not reached; the run does not prove timeout replay.
2. **Native claim failure:** HTTP 500 was returned where the test expects 503.
   This assertion occurs before rollback row queries, so those queries were not
   executed and rollback is not established by this failed test.
3. **Native outbox failure:** the saved-branch injection likewise returned 500
   instead of 503. Rollback queries and the rejected-branch injection were not
   reached; ordinary rejection creation passing elsewhere does not close this gate.

The earliest actionable failure is the historical schema chain: **E2/schema owner
handoff**, with original migration bytes/logs preserved. A reviewed recovery or
bootstrap strategy must respect the untouched history; E10 does not pre-create
objects, resolve migrations or replace replay with snapshots to bypass failure.
The two native status failures require **E2/backend receipt-telemetry owner review**:
the production route maps Prisma errors with P-codes to WORLD_UNAVAILABLE/503 and
unexpected/no-P-code exceptions to INTERNAL_ERROR/500 (also retryable). Determine
the correct native exception/fault-injection semantics and error classification;
do not silently change expected 503 to 500. No production defect fix was applied.
These owner handoffs are local review records; no external messages were sent.

A scoped E10 patch is prepared **only for parent review**, under the ignored path
`tools/explore-e10/.runtime/hosted/40057075433/proposals/e10-harness-diagnostics.patch`,
SHA-256 `4e0d1982a4f2e502954da661c9f083d14a6fd6628359dd6d65e17bbcf67ae1d2`.
It changes the timeout predicate to `originalUrl`, moves claim rollback queries
ahead of the preserved 503 assertion, and executes both outbox branches/rollback
queries before checking the preserved 503 assertions. It does not alter migrations
or production code. `git apply --check` and `node --check` on both proposed files
passed. The patch is **not applied, committed, pushed or DB-validated**. Existing
source/CI failure assertions remain unchanged in the worktree and approved SHA.

Original artifact and verification:

- Artifact ID `12545927187`, name
  `explore-e10-postgres-2bb36125e65d5b431b8557b94152296e6b889ce7-1`.
  Archive SHA-256 `54d773af7537bd0941d60508df2f4969e2f2da2f90391ec606de408a7c65726e`
  matches GitHub's artifact digest. Retention expires 2026-11-07.
- Download root: `tools/explore-e10/.runtime/hosted/40057075433/`; original ZIP,
  `original-run.log`, run/jobs/artifact API JSON, extracted artifact directory,
  `verification.json` and proposal are preserved there. Original logs/artifact
  bytes were not edited. File hashes and structured receipts are retained in the
  committed evidence JSON.
- All **56 source blob/raw SHA-256 identities** match the approved Git objects;
  all **13 manifest log hashes** match downloaded bytes; all **37 frozen-baseline
  files** match the exact parent Git objects. SHA/ref/workflow/run/attempt match.
- The extracted set is exactly **14 files**, with all eight telemetry checks per
  DB represented. `old-forward.local.log` is correctly absent because that step
  was not executed. Missing checks and failed/short-circuited assertions are not
  passes; artifact presence does not imply acceptance completeness.
- Targeted scanning of all 14 artifact files plus original run log found no DB
  URIs, bearer/JWT/GitHub tokens, known local fixture secret or standalone random
  48-hex container password. This is a targeted redaction check, not a proof
  against every possible secret format. No environment files/clients/dependencies
  appeared in the artifact.

The cleanup receipt is positive; no shared DB/flag/infra was touched. The same
substitutions remain: external erasure/export fan-out, generic analytics capture,
loopback sink table/pool rather than production provider/TLS/ensureTable, injected
clock/faults and due dates. Scheduler, real process/network loss, actual platform
fan-out and deployed sink permissions/throughput remain release gates.

Only report/evidence changes are committed locally in this continuation. No
follow-up push or unreviewed fix execution occurred. Remaining blockers: E2
historical migration strategy, parent review/hosted validation of the scoped
harness patch, native status classification and completed rollback proofs,
then a passing approved-candidate rerun. E9/integrated-app, actual sink/runtime,
E8 credential and E11 gates remain separate; E11 waits for an accepted integrated
E10 candidate. No Docker, DB, install, generation or build ran on this laptop.

## Parent-approved harness correction: 2026-10-24

Verified clean `feature/explore-e10-backend` at exact requested checkpoint
`5c18daf262a5d2941f5b4964d279d47ec9635e33`. Verified the approved patch hash
`4e0d1982a4f2e502954da661c9f083d14a6fd6628359dd6d65e17bbcf67ae1d2`, ran
`git apply --check`, then applied the patch from the preserved hosted proposal.
Its earlier status as unapplied in the historical run receipt is superseded by
this implementation record; the original proposal/logs/artifact bytes are unchanged.

The post-commit response hold now uses `req.originalUrl`. Its small middleware is
extracted to `tools/explore-e10/response-hold.mjs` and shared by the native harness
and the new regression, so the test exercises the actual hold implementation.
It still intercepts only the armed `saved` pickup response after the native route
returns its result. `arm`, `pending` and idempotent `release` replace the previous
inline state; release clears state and sends only if the response is not destroyed.
The native test retains its TimeoutError, committed-result/pending check, stored
receipt/replay and single-revision/outbox assertions, and releases in both local
and outer cleanup. No production middleware or API behavior changed.

Claim-failure native row assertions now run before status checking: receipt,
claim, progress and outbox must all be absent. The explicit claim-row assertion
also closes the prior test's omission. For outbox failure, both saved/rejected
requests and their four row-absence assertions execute before the status checks.
Both original **503 expectations remain**. The frozen error contract permits
retryable INTERNAL_ERROR/500 and WORLD_UNAVAILABLE/503; this patch supplies no
classification decision. E2 is handling historical provisioning and native error
classification in its separate session. No unreviewed E2 change was incorporated.

`response-hold.test.mjs` uses preinstalled Express 5.1.0 and real loopback HTTP,
with the same nested auth mounting topology (`app -> '/' auth router -> '/explore'
router -> '/pickups'`). Its synthetic handler imports no Prisma/service/gateway
code and makes no DB commit. Two regressions passed:

- The router observes `path=/pickups`, `baseUrl=/explore`, and stable
  `originalUrl=/explore/pickups`; the saved response is pending before a real
  1000ms client timeout. Release is safe and repeatable after disconnect, and a
  subsequent request succeeds. Cleanup closes the server/connections and clears
  armed/pending state.
- Other URLs and `already_saved` responses pass through while armed. A matching
  saved response is held and manual release returns its original 200/body before
  client timeout; repeated release and cleanup succeed.

This establishes **harness behavior only**, not database timeout/replay acceptance
or completed native rollback proofs. No CI rerun occurred. Run 40057075433 and
its tested SHA/results remain the latest actual hosted evidence, unchanged.

Executed lightweight validation with Node `v24.16.0`:

```powershell
node --test tools/explore-e10/redact.test.mjs tools/explore-e10/ci-evidence.test.mjs tools/explore-e10/migration-inputs.test.mjs tools/explore-e10/response-hold.test.mjs
```

**6 passed, 0 failed, 0 skipped.** `node --check` passed for the native test,
telemetry helper, shared hold/regression and collector/collector test. The final
additional claim-row assertion was syntax-checked after insertion. YAML branch,
read-only permission, full checkout, Node/Ubuntu, always-upload/failure invariants
and Bash syntax checks passed; no workflow shell command was executed. Existing
workflow and all production/schema/migration paths are unchanged. `git diff --check`
passed. SHA-256 comparison of **all 25 previously preserved hosted files** passed,
including the original ZIP/run log/extracted artifacts/proposal. No hosted file
was rewritten and no downloaded evidence was re-labelled as a passing rerun.

Collector source identities and its fixture now include the shared helper and
regression; README validation instructions include the loopback test. Synthetic
collector fixture cleanup passed. No Docker, DB, install, generation or build ran
on the laptop; no push, merge, CI dispatch or rerun occurred.

Exact intended continuation paths:

- `tools/explore-e10/postgres.test.mjs`
- `tools/explore-e10/telemetry-postgres.mjs`
- `tools/explore-e10/response-hold.mjs`
- `tools/explore-e10/response-hold.test.mjs`
- `tools/explore-e10/ci-evidence.mjs`
- `tools/explore-e10/ci-evidence.test.mjs`
- `tools/explore-e10/README.md`
- `docs/explore-e10-backend-report.md`
- `docs/explore-e10-backend-evidence.json`

Remaining gates: parent review of this implemented harness change; separately
reviewed E2 provisioning/classification inputs; then explicitly authorized hosted
validation of timeout/rollback and the full candidate. Existing E9/integrated-app,
actual sink/runtime, E8 credential and E11 gates remain. No current assertion is
relaxed to accept 500, and historical migrations remain untouched.

## Approved E2 handoff and additional bootstrap preparation: 2026-10-24

Verified clean `feature/explore-e10-backend` at exact requested checkpoint
`4e2d5d3c4def159d6332ecec750638543dfa10bf`. Read
`docs/explore-e2-rehearsal-fixes-report.md` and its offline exporter/tests from the
E2 worktree at `c9f95f39caf40d89c5a6a2ad81f9f31f0b99a984`; source E2 worktree
remains clean and untouched. Cherry-picked that exact reviewed commit cleanly as
`dd95019ef37b14687e175ccbca613b8fac70b92f`. The six approved E2 files remain
exact to that input; this adds documentation, route regression coverage and the
offline provisioning exporter, with no production error/schema behavior change.

The new owner decision supersedes the earlier retained-503 requirement **only for
generic trigger faults**. E10's HTTP helper now retains Retry-After. A shared
assertion requires exactly INTERNAL_ERROR/500, message key
`explore.error.internal_error`, `retryable=true`, a UUID v4 request ID, no extra
envelope fields and absent Retry-After. Claim and both saved/rejected outbox row
rollback checks remain before envelope assertions; both outbox responses are
collected before status/envelope assertions, with distinct server request IDs.
Faults remain plain generic trigger exceptions, not disguised connection failures.

After each trigger is removed in finally, the **identical command** retries: the
claim/saved cases must save once and subsequently return already_saved with the
original receipt; rejection must return FIX_INACCURATE and replay that rejection.
Three replays compare all receipt/progress/claim/outcome rows with their original
post-recovery state: exactly one progress/claim/event, revision 1 and one receipt
for saved; revision 0 and no receipt for rejected. These are prepared native
assertions, not newly executed DB proofs. Separate known-outage/typed-world 503,
Retry-After 5 and privacy coverage remains in the exact reviewed E2 route tests.

Parent explicitly authorized an **additional disposable bootstrap/baseline lane**.
This approval does not replace or waive the failed raw historical replay gate or
adopt this lineage for production. The older E2 proposal's acceptance-change
discussion does not enlarge this authorization. Existing raw fresh/old replay and
snapshot/runtime lanes remain; raw failures continue to make the overall runner
exit nonzero even if every additional bootstrap/native check passes.

Two new DBs, `e10_bootstrap_empty` and `e10_bootstrap_populated`, are owned by the
same disposable container (eight DBs total). `bootstrap.mjs` uses the unchanged
E2 exporter to read exact Git inputs: parent schema
`5214fa8dd8242093e542bd89a169dcf9321753b2`, forward SQL pinned at
`5c18daf262a5d2941f5b4964d279d47ec9635e33`, copied migration lock and historical
audit hashes. Current forward bytes must equal those pins. Historical audit files
never enter the executable staged directory. No existing failed DB is reset,
reused or marked resolved to create this lane.

On hosted execution only, locked/installed auth Prisma must both be **6.8.2**.
Render the parent-only schema to SQL, preserve exact stdout and its hash, and
stage it wrapped in BEGIN/COMMIT as the single distinct migration
`00000000000000_e2_parent_5214fa8_schema_bootstrap`. After verifying a new DB has
no user objects/history, run migrate deploy against that stage. This actually
executes/records the baseline; no manual applied rows are inserted. Seed only
the populated predecessor (synthetic User/CollectibleFind and User sequence),
then stage the three exact approved forward files and run migrate deploy again.

Each lane records complete native history before bootstrap, after baseline,
before upgrade, after upgrade and at failure if applicable. PostgreSQL JSON keeps
every field, including sub-millisecond timestamp precision. The one real baseline
row must remain unchanged; the final four completed names/checksums must match
executed SQL. Non-legacy auth data and sequence state must remain unchanged while
CollectibleFind and its owned sequence are intentionally removed. Only successful
bootstrap DBs receive the isolated booking schema and full native Explore,
telemetry, timeout/recovery, export/deletion and rollback suite. Failed bootstrap
leaves its native suite explicitly unexecuted, never passed.

This proves, if later successful, only a **new explicit snapshot-derived baseline
lineage**. It cannot prove preservation of genuine historical applied rows,
production schema/data lineage safety or deployment-lineage compatibility. Those
gates stay visibly open. Existing manual snapshot-upgrade history remains labelled
as that distinct prior evidence class; none is reclassified as historical replay.

CI artifact collection adds an explicit allowlist for rendered/wrapped SQL,
input manifest, tool/input/SQL provenance hashes, per-lane deployment logs and
complete history/data/sequence receipts, plus both additional native/telemetry
logs. Source identities include the new helpers/tests and reviewed E2 exporter.
Prisma CLI/package/lock hashes, Node version and exact runtime render/deploy
commands are recorded when hosted. No SQL was rendered locally; those output
identities are **pending hosted execution**, not invented current receipts.
No staged directory, client or environment file is uploaded wholesale. Redaction,
loopback ownership guards, failure propagation and final container/volume cleanup
remain. No deployment workflow is modified.

Lightweight validation actually executed:

- Tooling tests: E2 provisioning inputs plus E10 redaction, collector, baseline
  selection, response hold, exact envelope and staging tests: **10 passed, 0 failed,
  0 skipped**. Bootstrap staging uses synthetic SQL text only, never Prisma/DBs.
  An initial 8/10 pass exposed only the local Git ownership exception's trailing
  slash mismatch. The passing invocation scoped GIT_CONFIG_COUNT/KEY/VALUE to its
  subprocess environment with the exact safe.directory; no global config changed.
- Focused reviewed route command:
  `node --disable-warning=ExperimentalWarning --experimental-test-module-mocks --test --test-name-pattern='setup: mock Prisma|route error' services/auth-service/test/exploration.test.js`:
  **9 passed**, comprising setup and eight exception cases across all four routes.
  An initial focused invocation caught Node's asynchronous module-loader warning
  in the console privacy assertion (8 passed, 1 failed). Only that Node warning
  category was disabled for rerun; application console assertions remain intact.
  This is loopback/substituted-error evidence, not native outage evidence.
- Syntax checks for every added/changed E10 module/test passed. YAML permissions,
  exact branch/full checkout/Node/always-upload guards and Bash syntax passed;
  no workflow command was executed. Diff checks passed. Production exploration/
  Prisma, migration bytes, package locks and existing workflows remain unchanged.
- All **25 original hosted files** from run 40057075433 still match their recorded
  SHA-256 values, including archive, logs, extracted artifacts and proposal.
  Original hosted failure results and tested SHA are retained unchanged.

No Docker, DB, install, Prisma/client generation, SQL rendering or build ran
locally. Temporary tooling fixtures were cleaned. No push, merge, CI rerun or
deployment occurred. Stop for parent review: this combined preparation has no
new hosted receipt. Required gates remain raw historical replay, genuine-history
preservation and production-lineage review; actual hosted bootstrap/recovery/
timeout/native acceptance; integrated app/E9, actual sink/runtime, E8 and E11.

Exact additional E10 preparation paths:

- `tools/explore-e10/error-envelope.mjs`
- `tools/explore-e10/error-envelope.test.mjs`
- `tools/explore-e10/bootstrap-inputs.mjs`
- `tools/explore-e10/bootstrap-inputs.test.mjs`
- `tools/explore-e10/bootstrap.mjs`
- `tools/explore-e10/postgres.test.mjs`
- `tools/explore-e10/telemetry-postgres.mjs`
- `tools/explore-e10/rehearse.mjs`
- `tools/explore-e10/ci-evidence.mjs`
- `tools/explore-e10/ci-evidence.test.mjs`
- `tools/explore-e10/README.md`
- `docs/explore-e10-backend-report.md`
- `docs/explore-e10-backend-evidence.json`

The separate approved cherry-pick's exact six paths are recorded in its E2 report.

## Approved candidate hosted execution: 2026-10-24, 08:16-08:17 UTC

Verified clean `feature/explore-e10-backend` at exact parent-approved HEAD
`7915189104fa8559c32ee487f7491b9e73c4ac56`, with the expected GitHub origin.
Remote inspection returned `2bb36125e65d5b431b8557b94152296e6b889ce7`; verified
it is an ancestor of the approved candidate. Executed only:

```powershell
git -c safe.directory=C:/Users/rohit/Phool-Gobhi/wt/backend-e10 push origin 7915189104fa8559c32ee487f7491b9e73c4ac56:refs/heads/feature/explore-e10-backend
```

This fast-forwarded the feature branch without force. Identified the resulting
[run 40077401208, attempt 1](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40077401208)
using exact SHA, branch, `event=push` and
`.github/workflows/explore-e10-postgres.yml`. No duplicate dispatch or rerun was
issued. The `rehearse` job, ID `120823631947`, ran 08:16:37-08:17:41 UTC on the
Ubuntu hosted runner. It concluded **failure**, preserving the raw replay gate;
checkout/input verification, locked installs, image acquisition, evidence
collection and artifact upload all succeeded. Remote tip after execution remains
the approved SHA. No dev/main push, source-lane change, merge or deployment occurred.

Actual results are separate evidence classes:

| Gate | Observed result |
| --- | --- |
| Raw fresh historical replay | **Failed**: P3018 / PostgreSQL 3F000 at `20260704000000_add_user_onboarding_fields`, schema `auth` does not exist |
| Raw pre-feature historical replay | **Failed**, same migration/error |
| Populated genuine historical upgrade/applied-row retention | **Unexecuted**, blocked by the raw pre-feature failure |
| Existing populated snapshot upgrade | **Passed**, all three forward SQL files applied; labelled snapshot baseline row unchanged |
| Existing empty snapshot upgrade | **Passed**, same separate snapshot claim |
| New empty bootstrap/baseline lineage | **Passed**, verified empty DB, one actually executed baseline then three exact forwards |
| New populated bootstrap/baseline lineage | **Passed**, synthetic predecessor populated, non-legacy auth data/sequences retained |
| Native suite on runtime, two snapshots and two bootstrap DBs | **All five passed**, 21 leaf checks each |
| Harness-owned container/volume cleanup | **Passed per receipt**, `explore-e10-c982643832cb` and volumes removed |

Native totals: **105/105 leaf checks passed**, no failures/skips/cancellations.
Node includes one passing parent per DB: **110/110 tests passed**. Receipt telemetry
is a subset: **40/40** (eight per DB), not 40 additional tests.

The verified candidate exercised actual client timeout after commit and saved
replay on every DB (about 1012-1014ms). Each claim trigger fault and both saved/
rejected outbox faults proved no receipt/progress/claim/outcome residue before the
exact INTERNAL_ERROR/500 envelope, UUID and absent Retry-After assertions. After
each trigger was removed, the identical command recovered and replayed three
times with unchanged post-recovery native state: save once/already_saved with one
receipt/revision/event, or FIX_INACCURATE rejection with no receipt and one event.
Both outbox branches executed. These passes close the earlier native test failures
for this exact source; original failed results are not rewritten.

All five DBs also passed original-manifest delayed first claim after C2, rotation,
cold publication/claim races, account isolation, constraints/pagination, proof/
grace boundaries, rollback pending resolution/receipt retention, export/deletion,
and native outcome creation/privacy. Production delivery SQL passed separate
auth/sink connections, repeatable-read sink-default independence, concurrent sink
deduplication, native sink failure/backoff/retry, sink-commit/local-ack ambiguity,
competing workers and dispatcher/deletion ordering. Generic trigger failures do
not prove native connection loss; separate known-outage 503 route coverage was
retained but that substituted unit suite was not executed by this hosted workflow.

Bootstrap evidence was inspected independently of the main receipt. On each new
DB, `public._prisma_migrations` progressed from no history to one actual baseline,
then four executed records. Complete JSON rows preserve microsecond timestamps;
the complete baseline record has identical field values before/after upgrade, all
four finish successfully with no rolled-back marker, and all checksums match:

| Executed SQL | SHA-256 |
| --- | --- |
| Raw rendered pinned-parent SQL | `7e62e9bea8af1b585fc123fd556f36163f125d0414861201f07c9be9f8d17828` |
| Wrapped/executed `00000000000000_e2_parent_5214fa8_schema_bootstrap` | `90963e1149239e78c11f86cd0cd5856d89993e6f678d796c9d71b4b9e3c44030` |
| `20261023000000_exploration_core` | `9bf9cc8a767ddf16213acc37a4fd32482b982a7022d9aedb41ec0b12f6ca4028` |
| `20261023000100_drop_unreleased_collectible_find` | `40c6ce53c201a1b9ed56c74e89ca719b2e6e12abd8cfdc9779c20f15e1b9ec3b` |
| `20261023170000_explore_receipt_telemetry` | `205d911e23fa15899296352f305b141429bde185f1c5a44cc33b8878d87b99e0` |

The wrapped file equals BEGIN + exact rendered bytes + COMMIT; it was executed by
Prisma, not marked applied manually. Input manifest hash
`729d0e68ff39f2af237192023d9353feb8f2244a2f0e3def996c702597378b55`
matches the pinned E2 package. Empty/populated predecessor counts are 0/1; full
non-legacy auth/sequence snapshots match before/after. Historical SQL names are
absent from the new four-row executable lineage. This is preservation of the
**new explicit baseline**, not genuine historical applied rows or a production
lineage safety/acceptance receipt. The failed raw DBs were not repaired or resolved.

Hosted tool identities: Node `v24.21.0`, npm `11.19.0`, Docker `28.0.4` build
`b8034c0`; auth Prisma `6.8.2`, installed booking Prisma `6.19.3`, both isolated
clients generated by auth CLI `6.8.2`. Render/deploy commands, CLI/package hashes
and auth lock hash are preserved in bootstrap provenance. `postgres:16` image ID
is `sha256:066167ff39c2a612402ce99b734ea1cff92a9d1f2ac52f697a5f0384f0d88d6b`,
repository digest `sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97`.

Artifact verification:

- New separate directory: `tools/explore-e10/.runtime/hosted/40077401208/`.
  Original ZIP/job log and run/jobs/artifact API JSON are retained unchanged,
  alongside extraction and an inspection-only `verification.json`/script.
- Artifact ID **12553767541**, name
  `explore-e10-postgres-7915189104fa8559c32ee487f7491b9e73c4ac56-1`;
  archive SHA-256 **`2dea8f50e15965406838ac642d80ed560b6bf28f33e3afedbfb0bed8051b4560`**
  matches GitHub's digest. Retention expires 2026-11-07.
- **68 source blob/raw hashes**, **28 artifact hashes**, **41 pinned input hashes**
  and **37 baseline audit files** match their exact Git/data identities. SHA,
  branch, workflow, run and attempt match. Extracted file set is exactly the
  manifest's **29 files**, including rendered SQL and both complete bootstrap
  receipts. Old-forward log is correctly absent because that historical upgrade
  was not executed; its missing proof remains open.
- All eight telemetry cases appear and pass in each of five receipts. Targeted
  credential/URI/token scanning of 29 artifact files plus original job log found
  no matches; this is not a proof against every possible secret format.
- All **25 original files for run 40057075433** still match their previous hashes.
  No prior hosted receipt or artifact was edited or relabelled. The committed
  evidence contains exact new receipts, source/log identities and verification.

Earliest actionable failure remains **E2's raw historical schema/lineage gate**:
the first unqualified migrations do not provision the later auth namespace/state.
No new workflow/harness/native failure was observed. This session did not patch,
retry, dispatch or waive anything after the red conclusion. Genuine historical
upgrade preservation remains unexecuted; production/deployment lineage adoption
requires owner review. Bootstrap success cannot authorize production use.

Scoped runtime substitutions remain external export/erasure fan-out, generic
analytics capture, loopback sink fixture/pool instead of deployed provider/TLS/
ensureTable, and injected clocks/faults/due dates. Scheduler/backlog, actual process/
network loss, deployed sink permissions/throughput and integrated-service side
effects are not proved. E8/E9 fixes, integrated-app journeys and device/location/
accessibility/pilot acceptance are separate pending work; none was incorporated
or accepted by this backend run. E11 still requires an accepted integrated E10.

Only this report/evidence update is committed locally. No follow-up push, merge,
deployment, dev/main publication or shared DB/flag/source-lane change occurred.
All Docker/DB/install/generation/build execution stayed on the hosted runner;
local work was Git/gh and receipt/hash inspection only.

## Exact owned change set

New E10 commit paths:

- `docs/analytics-events.json`
- `docs/explore-e10-backend-report.md`
- `docs/explore-e10-backend-evidence.json`
- `tools/explore-e10/.gitignore`
- `tools/explore-e10/README.md`
- `tools/explore-e10/http.test.mjs`
- `tools/explore-e10/postgres.test.mjs`
- `tools/explore-e10/rehearse.mjs`
- `.github/workflows/explore-e10-postgres.yml`
- `tools/explore-e10/redact.mjs`
- `tools/explore-e10/redact.test.mjs`
- `tools/explore-e10/ci-evidence.mjs`
- `tools/explore-e10/ci-evidence.test.mjs`

The earlier E4 cherry-pick additionally changes exactly:

- `services/booking-service/controllers/bookingController.js`
- `services/booking-service/services/bookingService.js`
- `services/booking-service/test/visitedGyms.test.js`

Ignored logs, generated clients, schemas, dependency junctions and temporary
rehearsal output are local-only and are not staged. No parent integration merge
or dev/main publication is authorized or performed by this receipt. The reviewed
feature SHA was published only as explicitly recorded in the hosted receipt.
