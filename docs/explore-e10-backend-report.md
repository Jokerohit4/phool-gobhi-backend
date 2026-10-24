# Explore E10 backend candidate and migration rehearsal

2026-10-24. **Combined backend/telemetry candidate prepared; hosted PostgreSQL remains unexecuted.**
This is not an Increment A acceptance receipt. Full E10 also awaits the integrated
app, actual generator implementation/device evidence and E11 acceptance. No merge
to dev/parent, push, deployment, shared flag change or external message occurred.

## Source identity and isolation

| Input | Exact identity |
| --- | --- |
| Approved backend core | `0db69a2496f9fd46afd5037dffd4640250f00990` |
| Approved E4 | `199337004f88464f374fc387800b67bd75926059` |
| Approved E10 CI preparation | `6198594243847b1c52861db8272b133b28a20e8b` |
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

1. Execute the dedicated hosted E10 workflow after parent review and separately
   authorized publication; retain successful migration/history,
   populated/empty upgrade, constraint/race, delayed-first-save, rotation,
   account-export/deletion and rollback receipts. All these real DB checks are
   currently unexecuted, not failed assertions or mock evidence.
2. Approved backend receipt telemetry is incorporated. Native delivery/deduplication,
   lifecycle and E9 integrated-app payload evidence still require reviewed receipts.
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
or external publication is authorized or performed by this receipt.
