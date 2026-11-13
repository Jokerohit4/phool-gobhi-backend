# Analytics warehouse operations

The migration uses GCP project `phool-gobhi`, region `asia-south1`, datasets
`analytics_dev` / `analytics_prod`, topics `analytics-events-dev` / `analytics-events-prod`,
and managed Pub/Sub BigQuery subscriptions ending in `-warehouse`.
Operational application databases stay on Neon. Dev's analytics table shared its
transactional database; never suspend or delete that compute to retire analytics.

## How events and reports work

Requests batch their own events and wait up to four seconds for Pub/Sub acceptance.
`POST /api/events` returns 202 after acceptance, or retryable 503 on publish failure.
Optional server telemetry does not fail a booking/payment response. Explore receipt
events retain their operational outbox, original timestamp and stable delivery UUID;
auth requests also drain one pending receipt while request CPU is allocated.

Clients may send an optional UUID `event_id` with immutable ISO `occurred_at`.
That timestamp must be no older than seven days or over five minutes in the future.
Persist both fields across retries. The gateway scopes the ID hash to the event
name and client distinct ID; keeping the occurrence time also keeps retries in the
same reporting partition/window. An ID without a valid occurrence time is dropped.
Older clients without an ID can duplicate a whole HTTP retry. Pub/Sub delivery is
at least once: query `events_between(start_at,end_at,event_names)`, not raw counts.
An empty/null event-name array means all events. The function deduplicates IDs and
excludes pipeline probes, erased actors, and source-deleted legacy events.

Raw data is partitioned by event timestamp and clustered on common filters. Common
JSON values also have scalar columns. Reads bind parameters, prune time/events,
reuse a one-minute application cache, paginate REST results, and cap each query at
256 MiB. Full-history queries retain all source history; there is no raw TTL until
first-booking and identity facts can preserve first-ever semantics independently.
Account-wide analytics export/erasure still needs integration; the pre-existing
separate-sink contract is documented in the audit's launch follow-ups.

## Configuration and permissions

`deploy/services.json` declares all sixteen runtime configurations. The provider is
`bigquery`, topic/environment must match, and only booking sets
`ANALYTICS_READ_PROVIDER=bigquery`. `ANALYTICS_DATABASE_URL` remains an inert rollback
secret in BigQuery mode; no analytics pool is created on that path.

Apps publish using existing Cloud Run workload identities and topic-scoped publisher
grants. The managed Pub/Sub agent writes the datasets. Booking's existing runtime
identity has dataset read and project job permissions. These identities are shared
with siblings; IAM separation beyond those existing identities is a follow-up.
No service-account key, public dataset, or custom subscriber is introduced.

## Monitoring and cost guardrails

- Pipeline alerts use the existing operations email channel: oldest unacknowledged
  message over five minutes, pending dead-letter messages, and redacted
  `ANALYTICS_PUBLISH_FAILED` logs.
- The project custom query quota is 25 GiB/day, with an application limit of
  256 MiB/query. Google's daily quota is approximate. Exhaustion makes reports
  unavailable; ingestion continues.
- A ₹500/month BigQuery/Pub/Sub budget emails at 50%, 80% and 100%.
  It is an alert, not an automatic service shutdown or universal spend cap.
- BigQuery has a minimum billed scan per table/query. Use billed bytes, cache hit
  rate and envelope size when forecasting; small logical scans alone understate cost.
  The managed subscription has its own delivery charge and no first-10-GiB exemption.
- See `analytics-cost-model.json` for dated Mumbai/INR catalogue rates and scenarios.
  Free allowances, credits, monitoring, Cloud Run request overhead, retention, and
  growth affect the final invoice. No permanently free claim is made.

Reconcile infrastructure with `python deploy/analytics/provision.py --apply`, runtime
IAM with `python deploy/analytics/grant_runtime.py`, and guardrails with
`python deploy/analytics/cost_and_alerts.py`. Inspect the plan before changing a quota.

## Backlog and dead letters

Inspect the `-warehouse` subscription state, BigQuery schema, Pub/Sub service-agent
dataset permissions, and latest publish-failure logs. Repair the cause before replay.
Keep all dead-letter payloads private. Publish the exact original JSON with the
original `event_id` to its environment topic; acknowledge the dead-letter message
only after the new publish succeeds. Redelivery can produce raw duplicates, which
the report function removes. Never log actor IDs, properties or credentials.

`verify_dead_letter.py` creates isolated temporary subscriptions/topics and validates
malformed-row forwarding; it never pulls the live dead-letter backlog.
`verify_replay.py` replays an existing event privately and proves two raw copies
produce one report event. `pipeline_probe.py` checks real runtime identity permissions
with temporary jobs, which are removed when finished.

## Snapshot reconciliation

`python deploy/analytics/backfill.py dev|prod` takes a consistent read-only source
snapshot, loads a private staging table, merges stable IDs, compares JSON semantics,
and reconciles source-deleted legacy IDs using report tombstones. Local event files
and staging tables are removed; only aggregate receipts remain. It preserves source
timestamps to microsecond precision. Run the final snapshot after all old writers
stop. Do not run it against a replacement/truncated source without reviewing its
source identity and intentional deletion scope.

CLI reports default to BigQuery and use the active `gcloud` login:

```powershell
$env:ANALYTICS_ENVIRONMENT='prod'
node scripts/analytics-digest.cjs
node scripts/investor-metrics.cjs
```

The demo partner seeder requires `ANALYTICS_ENVIRONMENT=dev`, commits its operational
seed before publishing warehouse events, and scopes cleanup to the selected demo gym.
Its warehouse phase is not atomic with that PostgreSQL transaction; an operator must
retry a reported analytics failure. Explicit `ANALYTICS_PROVIDER=postgres` retains
legacy seeding for rollback/testing. Do not run the seeder as a health check.

## Rollback

The deployment receipt records old and new immutable images and ready revisions.
Update only the affected service's image and analytics provider/read provider, retain
private ingress, runtime identity, secret references and resource settings. Secrets
still contain the old connection URI. Resume the dedicated production analytics
endpoint before returning readers or writers to PostgreSQL.

After BigQuery-only cutover, PostgreSQL no longer contains newer warehouse events.
Changing a reader back immediately would hide that interval. Before a full storage
rollback, export the missing warehouse rows privately, insert them idempotently with
their original event IDs/timestamps into the old sink, reconcile, and then switch
readers. Prefer fixing/reverting the warehouse adapter while leaving accepted events
in the managed pipeline. Never delete a source database as part of rollback.

Production migration images are based on provenance-verified live production source,
with an audited analytics patch only. Do not deploy the current dev application to
production merely to reproduce this migration.

## Legacy compute and QA exception

`analytics-neon-retirement.json` records that the dedicated production analytics
endpoint is idle and uses the default five-minute suspension policy. Its source
contents were unchanged across final snapshots, and no operational database URL
references it. Retained source storage can still incur storage charges.

The pre-existing `partner-auth-validation` tag on auth-service-dev has zero assigned
traffic and keeps its own QA revision. It uses dev's shared database and cannot
wake the dedicated production analytics compute. Retire or migrate that tag when
its separate feature validation ends; do not promote its older analytics settings.

The migration code/configuration is promoted through dev. A future normal production
release must include this migration commit; the pre-migration main manifest still
selects PostgreSQL. Current production images are the separately validated patches
recorded in the deployment receipt, preserving its existing application version.
