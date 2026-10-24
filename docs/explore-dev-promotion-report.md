# Explore dev promotion completed - 24 October 2026

Both remote dev branches were promoted after the explicit decision **Promote both
to dev**. The backend deployment completed successfully. Feature/queue diagnostic
activation remains off. Main dirty local checkouts were preserved.

| Repository | Remote dev commit |
| --- | --- |
| Customer app | `2ce53a7d7fca46e6fe61d777f662508165448c02` |
| Backend | `1dc60ce3990f467dba0293637f1cda49bb7c8697` |

## Executed verification

- App merged with both current dev commits: 5,209 tests passed, concurrency 1;
  whole-app analysis clean. The complete run includes the final request-token fix.
- Final backend boundary/audit/fixture unit suites: 37 passed.
- Hosted source `1dc60ce3990f467dba0293637f1cda49bb7c8697` in run 40107599517: 126 native cases across six
  isolated databases passed. Snapshot/bootstrap lanes and the captured actual-dev
  schema/shared-ledger lane passed; owned containers/volumes were removed.
- All 82 source identities, 33 artifact hashes and archive digest verified.
- Dev lineage rehearsal preserved every field of all 143 genuine ledger rows,
  applied exactly three Explore migrations, and retained non-legacy synthetic
  auth data and sequence state. Actual account records were never copied.
- Existing fresh/old raw replay failures remain recorded. Parent acceptance is
  scoped to the verified existing-dev lineage, not an assertion that raw fresh
  historical replay works or an adoption of a new production baseline.

## Live deployment and post-checks

[Deployment 40108102439](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40108102439)
completed successfully, including gateway/auth/booking unit tests, database
integration tests, preflight and all three deployments/health checks.

| Service | Ready revision | Traffic |
| --- | --- | --- |
| Gateway dev | `gateway-dev-00058-5mr` | 100% |
| Auth dev | `auth-service-dev-00104-nqw` | 100% |
| Booking dev | `booking-service-dev-00092-kx9` | 100% |

Read-only live verification confirms 146 total ledger rows: every original 143
row unchanged, plus the three successful/checksum-matched Explore migrations.
The intended unreleased legacy table is removed; the auth user count remains
129. Explore is disabled in live configuration. Queue diagnostics are absent/off
in all three deployed services. Gateway health and app-config return 200; an
unauthenticated Explore catalogue request returns typed 401 AUTH_REQUIRED.

The temporary metadata fixture secret was deleted and its absence verified.
Rehearsal fixtures contained schema/history only, no DB URL or account records;
all account data used by the hosted clone was synthetic. Local Docker, DB server,
installation, generation and native app builds were not run.

## Remaining rollout work

This is a completed development promotion. Device acceptance, signed tester
builds/distribution and the seven-day Checkpoint 1 diary remain future work.
Delivered-data retention/account erasure remains required before enabling queue
diagnostics. Fresh-environment lineage remains a separate gate. No production
promotion or feature activation occurred.

Exact source, service/image and artifact identities are in the
[promotion evidence manifest](explore-dev-promotion-evidence.json). Previous
blocked/failing receipts are preserved as historical evidence. This report
supersedes their current-status statements. Documentation is recorded on an
audit branch so the approved/published dev candidates remain unchanged.
