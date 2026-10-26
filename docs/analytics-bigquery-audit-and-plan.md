# Analytics audit and BigQuery migration plan

Status: migration executing, 26 October 2026. Dev and production use BigQuery. See the runbook and generated receipts for current evidence.

## Current implementation and findings

1. Eight deployments contain their own `utils/analytics.js`. Six service copies
   match; gateway and auth have separate behavior. Auth also owns durable Explore
   receipt delivery. A migration must cover all eight services in both environments.
2. All eight services in an environment use the same analytics connection URL.
   Dev and production have different URLs. Source identities must be derived from
   endpoint/database, not credentials, so a password rotation cannot duplicate history.
3. Read-only inventory: dev has 11,297 events, 534 in 24 hours, about 6.2 MB with
   indexes; production has 8,297 events, 72 in 24 hours, about 5.1 MB with indexes.
   Mean JSON properties are 302 / 338 bytes. These are observations, not launch forecasts.
4. Normal tracking is fire-and-forget. The gateway returns 202 before storage
   acknowledges events. Cloud Run can throttle or terminate after a response.
   Database connection failures are swallowed. This cannot promise durable acceptance.
5. Every process lazily runs CREATE TABLE and four CREATE INDEX statements. Pools
   are duplicated across replicas, and a schema-setup failure still allows insertion.
6. Analytics connections explicitly set `rejectUnauthorized:false`; some pools
   have no connection/query deadline. The warehouse path must use verified HTTPS
   and workload identity, without service-account keys.
7. Analytics is not operational truth. Booking/wallet operational metrics must
   continue reading their transactional databases.
8. Explore receipt telemetry has an operational transactional outbox, advisory-lock
   sink deduplication and retry tests. Its event IDs, original timestamps and
   commit-before-mark-delivered behavior must survive the move. Timer-only delivery
   can stall when Cloud Run CPU is throttled.
9. Queue-diagnostic events currently allow only the Postgres first-party sink.
   BigQuery must be added explicitly; console and third-party fallbacks remain forbidden.
10. The booking analytics query service has 28 exports, including two profile/auth
    helpers, and 44 generated SQL statements. Across all consumers there are more
    than 50 statements. Consumers include partner/admin HTTP
    reports, anonymous/user journeys, dynamic property search, sequential funnels,
    cohorts, plus `analytics-digest.cjs` and `investor-metrics.cjs`.
11. Several queries scan all history: event/property suggestions, identify mapping,
    cohort first-ever activity and the resolved side of approval SLA. Cohort and
    identity semantics must not silently become 'first in the selected window'.
12. Reports return PostgreSQL numbers, JSON objects and JavaScript Date values.
    BigQuery's REST strings/nested rows/timestamps need compatibility decoding.
13. The gateway enriches ordinary client events with raw IP and user agent. Actual
    historical rows contain these fields despite comments saying no PII. This is a
    privacy and storage finding; queue diagnostics deliberately omit enrichment.
14. Existing auth export/erasure follows separate analytics conventions; it does
    not implement general analytics-sink erasure. The new warehouse must document
    and test retention/suppression rather than claim the old implementation erased it.
15. Current app-version and deployment histories differ between dev and production
    (production Health Profile is absent). Shipping every dev feature to production
    as part of an analytics-only migration is unacceptable. Production migration
    images must preserve the actual live source except reviewed analytics changes.
16. Dev analytics shares the actual transactional database endpoint/database.
    Production analytics is separate. Never suspend or delete the dev compute to
    retire analytics; only the verified dedicated production analytics compute is eligible.

## Selected architecture

`backend request -> Pub/Sub publish acknowledgement -> managed BigQuery subscription`

No permanent analytics database compute, Dataflow worker or custom subscriber.
Per-request publishing batches amortize request overhead without holding an
unacknowledged in-memory batch across requests. A bounded response drain keeps
Cloud Run CPU allocated until publishing finishes. Business responses stay
independent of optional analytics failures; client analytics acceptance is durable
only when publishing succeeds. Publishing failure is counted and alerted.

Pub/Sub BigQuery delivery is **at least once**, not exactly once. Every event has
a stable application event ID; report reads deduplicate it. Explore retains its
operational outbox and publishes its existing delivery UUID. A dead-letter topic,
subscription backlog alerts and replay tooling make failures recoverable.

Dev and production use separate topics/datasets. BigQuery raw events are daily
timestamp-partitioned, clustered on common filters, and require partition filters.
Frequently queried JSON scalars are also projected into typed columns, allowing
reports to avoid scanning full properties. Retention initially preserves existing
365-day report contracts and all current history; shortening it is a separate choice.

Report queries use bounded table functions, parameter binding, explicit byte caps,
query-result caching and short application caching. Existing exact counts and
response contracts must pass parity tests; approximate distinct counts are not
silently substituted. Long-lived cohort/identity queries retain the entire source history. Raw partition
expiration stays disabled until persistent first-booking and identity facts can
replace it without changing first-ever cohort definitions. The normal dashboard
queries still prune their requested time windows and relevant event names.

## Cost controls

- No reserved slots or always-running analytics compute.
- Pub/Sub BigQuery export costs $50/TiB delivered; its first 10 GiB are **not** free.
- Batch publishes within each request (Pub/Sub has a minimum billed request size).
- Enforce per-query maximum bytes, a project query-usage quota, bounded time ranges,
  result-cache reuse, backlog alerts and a billing budget. A budget alert is not a cap.
- Model both 4,200/day and 414,400/day launch scenarios. At 1 KB/event these are
  approximately 0.126 GB/month and 12.4 GB/month of payload, before envelope,
  duplicate, query and retention overhead. Avoid claiming permanently free service.
- Do not schedule a new compute service merely to flush tiny event batches.

Pricing/reference sources:
[BigQuery](https://cloud.google.com/bigquery/pricing),
[Pub/Sub pricing](https://cloud.google.com/pubsub/pricing),
[managed delivery and at-least-once behavior](https://docs.cloud.google.com/pubsub/docs/bigquery).

## Execution and cutover gates

1. Inventory every live service, runtime identity, analytics source and consumer.
   Capture rollback configuration and production image/source identities.
2. Provision private regional datasets, raw tables, bounded deduplicating reads,
   topics, managed subscriptions, dead letters, least-privilege IAM and cost controls.
3. Implement one canonical transport, checked vendored copies for isolated service
   builds, bounded request draining, outbox delivery and report compatibility.
4. Backfill each source using read-only consistent snapshots. Historical IDs use
   stable source identity plus original row ID; preserve timestamps and properties.
   Migration overlap must deduplicate, not double-count.
5. Dry-run every generated report query and compare historical results with
   PostgreSQL, including empty/null cases, cohorts, identity linkage, property-key
   injection attempts, dynamic sequential funnels and timestamp/number decoding.
6. Validate real publish, managed delivery, duplicate suppression, poison-message
   dead letters and runtime IAM. Validate timeout/error behavior and account data handling.
7. Move dev through shadow/dual mode, compare counts and HTTP report contracts,
   then move production with analytics-only production patches. Verify every
   service's active image/configuration and drain the old writer/outbox backlog.
8. Final delta backfill and per-day/event/service reconciliation. Prove reporting
   and command-line consumers use BigQuery and no runtime still writes analytics
   to Neon. Keep source data and a rollback record; suspend the dedicated analytics
   compute after verification. Never delete the transactional databases.
9. Publish evidence: exact revisions, IAM/resources, query parity and bytes, replay
   checks, backfill counts/checksums, observed delivery lag, costs and rollback steps.

## Work log

- Audit completed against repository source and read-only live dev/prod inventories.
- Private regional warehouse and managed delivery provisioned in both environments.
- All 44 repository report statements matched source results in both environments;
  all 41 statements from actual production source passed separately. All ten CLI
  statements matched too. Receipts contain hashes and counts, never event payloads.
- Eight local suites passed: 33 gateway, 903 auth, 241 booking, 158 buddy,
  105 challenge, 73 gym, 1,653 health, 61 wallet tests; 23 native-database tests
  require the hosted PostgreSQL checks.
- Workload-identity probes passed for gateway, dev compute, and prod backend.
  Managed delivery replay returned two raw copies and one report event in each
  environment. Malformed-message quarantine preserved payload and cleaned up its
  temporary resources.
- 25 GiB/day project query quota, 256 MiB/query application limit, three pipeline
  alerts and a INR 500/month BigQuery/Pub/Sub billing alert configured. Quotas are
  approximate and budgets notify; neither is a universal billing hard stop.
- Dev source changed between snapshots. Snapshot reconciliation now excludes
  source-deleted legacy event IDs without physically deleting rollback history.
- A ninth writer was found: the manual demo partner seeder. It now publishes
  warehouse events after operational commit with stable IDs and scoped cleanup;
  explicit legacy mode remains available for rollback/testing.
- Production builds use provenance-verified deployed source archives and change
  only analytics modules, response draining, the optional client event ID, and
  report dispatch/sort stability. Existing production features remain preserved.

## Remaining launch work outside the storage cutover

- The existing auth deletion/export contract does not include general analytics.
  `erased_actors` suppresses report reads but is not wired to account deletion.
  Add a durable erasure/export workflow and replay-aware physical cleanup before
  claiming complete account-wide analytics erasure; keep retention decisions explicit.
- Persist first-booking and identity dimensions before introducing raw-history TTL.
  Introduce exact daily rollups/cache tables when query p95 scan estimates approach
  64 MiB or 70% of the daily quota; keep raw-event queries for journeys/funnels.
  Do not silently approximate distinct users, medians, or cohort definitions.
- Booking is the only warehouse reader in application code. Existing runtime
  accounts are shared with sibling services (dev compute also has pre-existing
  broad project privileges); grant-level separation requires distinct identities.
- Older clients without `event_id` can duplicate an entire HTTP retry. Transport
  retries and Explore outbox retries reuse IDs. Clients should send a persisted
  event UUID and immutable `occurred_at` for HTTP replay deduplication.
- Optional server telemetry remains best effort on publish failure. Explore receipt
  telemetry retains the operational transactional outbox and retry semantics.
- No 50x launch-load test is claimed by these migration checks. Monitor request
  overhead, managed-delivery lag, envelope sizes and billed query bytes at launch.
- Neon endpoint timeout `0` means the provider default, not 'never suspend'; `-1`
  disables suspension. The dedicated analytics endpoint was observed idle. Moving
  analytics cannot eliminate transactional Neon charges; dev analytics shared the
  transactional database and that database stays running.
