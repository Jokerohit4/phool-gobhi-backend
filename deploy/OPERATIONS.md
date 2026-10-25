# Backend operations

Cloud project: `phool-gobhi`; Cloud Run region: `asia-south1`.

## Monitoring

`python deploy/scripts/cloud_health.py monitoring --email officialrohitashwa@gmail.com`
reconciles two five-minute HTTPS gateway uptime checks, six alert policies,
the operations dashboard and the notification channel. It is safe to repeat.
Internal services retain their private Cloud Run IAM configuration.

Alerts cover failure from two uptime regions, more than four server errors in
five minutes per service, production p95 latency above five seconds for ten
minutes, and CPU/memory p95 above 85% for ten minutes. Dashboard percentiles
show the worst revision per service, rather than a merged traffic percentile.
At low traffic, individual cold starts can dominate those percentiles.

For an incident, identify the affected service and revision in Cloud Logging.
Check Cloud Run readiness, traffic, the failed API path and database connectivity.
An HTTP 200 from `/health` does not establish that every product route exists.
Preserve the deployed image and traffic details before any rollback.

## Configuration

Preview declared value changes with `python deploy/scripts/cloud_health.py config`;
apply them with `--apply`. Only declared plain variables that differ are updated.
Secrets, IAM and resource limits are preserved. The deployment manifest records
production Firebase OTP and explicitly disables dev OTP.

The 25 October 2026 reconciliation restored production buddy/gym auth-service
URLs, buddy runtime/analytics settings, health wallet URL and the declared
`general_wellness` assistant policy. No application data or consent was edited.

## Connectivity and live reads

`node deploy/scripts/verify-live-reads.cjs dev` (or `prod`) uses an existing
customer to verify read-only auth, booking, subscription and health-profile
routes. It checks unauthenticated rejection too. Credentials and response data
are never printed; it performs no booking, payment, OTP, notification or consent
write. Production currently lacks the newer `/health-profile` route: that check
must remain a visible failure until a separately validated product rollout.

The live checks on 25 October found both application databases reachable over
TLS, all seven service schemas present, no unfinished migration, no idle
transaction and no active query older than 30 seconds. Health-service Redis is
unset in both environments; its cache intentionally uses the optional fallback.

## Recovery verification

Workflow **Verify database backup restoration** obtains a consistent, read-only
live snapshot for each environment. PostgreSQL 17 dumps it over verified TLS,
restores it into a labelled disposable Docker database, and compares row counts
and order-independent content hashes for every application table. Only a
redacted receipt is uploaded. Dumps, credentials and restored data are deleted;
the source database is never restored or modified.

Successful drill: [40197772078](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40197772078).
This verifies logical recovery, not recurring backup retention. Neon management
access is also required to inspect the application's point-in-time recovery
window. The analytics project has six hours of history; its historical clone
was connected to successfully and the owned drill branch was deleted.

## Scheduler

`daily-partner-briefing` previously lacked Cloud Run authentication and failed
with permission denied. It now uses OIDC as
`scheduler-briefings@phool-gobhi.iam.gserviceaccount.com`, which has invoker only
on `booking-service-dev`. Its existing internal header and schedule are retained.
Do not manually invoke the briefing endpoint for a health check: it sends pushes.
Inspect the next scheduled execution to verify delivery.

## Historical auth replay

Original applied migration files and ledger rows must remain unchanged. The
isolated rehearsal revealed that old unqualified SQL assumed an `auth` search
path and depended on externally provisioned `SavedAddress` and base user fields.
`20260703000000_restore_auth_foundation` is an additive prerequisite repair,
ordered before its historical consumers. It creates missing foundations and
is a no-op for already provisioned objects. The rehearsal stages this repair
alongside the exact frozen old migration bytes and records its own checksum.
Every existing strict replay, upgrade and native HTTP/PostgreSQL gate remains.
