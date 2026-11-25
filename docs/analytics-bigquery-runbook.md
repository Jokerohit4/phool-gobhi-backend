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

## App vs web reports

Both reports read the deduplicating `events_between` function through
`scripts/analytics-client.cjs` and use the shared definitions in
`scripts/analytics-identity.cjs`. Caveats that apply to every number they print:

- **Web is not the app.** Client events carry `properties.platform` = `ios`, `android`
  or `web`. About 90% of `session_started` users in 30 days are anonymous marketing-site
  visitors (`anon_...` ids, platform `web`). Server events (`signup_completed`,
  `login_completed`, `booking_created`, ...) have no platform; reports attribute them
  through the person's first client-reported platform (ios/android preferred over web).
- **Identity.** A device is anonymous (`anon_...`) until an `identify` event whose
  `anon_distinct_id` property links it to the numeric user id. Reports fold anonymous events
  into the user through that link; unlinked devices stay separate people.
- **Booking funnel event** is `booking_created` (not `booking_confirmed`).
- Days are IST calendar days. Queries are time-bounded (`scanDays`) to stay far below
  the 256 MiB per-query cap.

`node scripts/analytics-digest.cjs` (30-day window) prints the traffic mix, the booking funnel
split by app / ios / android / web / unknown, and the **app activation funnel**: saw a screen,
requested OTP, logged in, signup_completed, coach_onboarding_completed, home_viewed,
workout_started, returned on a later IST day. Each stage counts unique people; the output states
both "reached" (did it at least once) and "funnel" (reached every stage up to this one).

`node scripts/retention-by-signup-day.cjs [--since YYYY-MM-DD] [--until YYYY-MM-DD]
[--platform app|web|ios|android|all] [--json]` prints, per signup day and in total: cohort size,
D1/D3/D7 return, "any later day" return, % onboarded, % who started a workout within 24h and the
median active minutes after onboarding on day 1. A user returns on day N when they have any event
on signup day + N other than identify / signup_completed / login_completed; only users whose
day N has fully passed count toward DN. Platform comes from the person's first client event, so
a user seen on both ios and android is counted once, under the first.

### Admin endpoint: retention by signup cohort

`GET /api/bookings/admin/analytics/retention-signup-cohorts` (gobhi role; booking-service route
`/admin/analytics/retention-signup-cohorts`, reaches booking-service through the existing
`/api/bookings` gateway proxy). It is the CLI above as an endpoint, one warehouse query per
request (about 2 MB scanned for a 12-day window; the usual 256 MiB cap and one-minute cache apply).

Query string (all optional; bad values are a 400, never silently widened):

| param | values | default |
|---|---|---|
| `since` | `YYYY-MM-DD` IST signup day, within the last 180 days | 30 days ago |
| `until` | `YYYY-MM-DD`, inclusive, not before `since` | today (IST) |
| `platform` | `app` (ios+android), `ios`, `android`, `web`, `all` | `app` |
| `granularity` | `day`, `week` (Monday-start IST weeks) | `week` |
| `cohort` | same account-cohort filter as the other admin analytics | all |

Platform attribution: the `platform` property stamped on the `signup_completed` event itself
(auth-service, from the `x-app-platform` header) when present, otherwise the person's first
client-reported platform. People with neither are "unknown" and only appear under `platform=all`.

Response (counts, not rates, for the retention columns; `*Pct` are 0-100 numbers with one
decimal, or `null` when the cohort is empty):

```json
{
  "data": {
    "since": "2026-11-12",
    "until": "2026-11-23",
    "platform": "app",
    "granularity": "week",
    "generatedAt": "2026-11-23T18:21:25.035Z",
    "cohorts": [
      {
        "start": "2026-11-16",
        "size": 25,
        "d1": { "returned": 7, "eligible": 24 },
        "d3": { "returned": 1, "eligible": 19 },
        "d7": { "returned": 0, "eligible": 0 },
        "anyLater": { "returned": 8, "eligible": 25 },
        "onboarded": 22,
        "onboardedPct": 88,
        "workoutWithin24h": 3,
        "workoutWithin24hPct": 12,
        "medianActiveMinutesDay1": 1.1,
        "activeMinutesSample": 21
      }
    ],
    "total": { "size": 30, "d1": { "returned": 9, "eligible": 27 }, "d3": { "returned": 3, "eligible": 22 },
               "d7": { "returned": 0, "eligible": 3 }, "anyLater": { "returned": 11, "eligible": 28 },
               "onboarded": 27, "onboardedPct": 90, "workoutWithin24h": 5, "workoutWithin24hPct": 16.7,
               "medianActiveMinutesDay1": 1.4, "activeMinutesSample": 25 }
  }
}
```

(The sample row is abbreviated from a real prod run; `start` is the bucket's first day: the day
itself for `day`, the Monday for `week`.) UI rules: show `returned/eligible`, and treat
`eligible: 0` as "not yet measurable" (day N has not fully passed), never as 0%. A user counts
toward DN only after signup day + N is over, so the newest cohorts are always partial.
`medianActiveMinutesDay1` is `null` when nobody in the cohort onboarded on their signup day;
`activeMinutesSample` is how many people it is based on. Check small cohorts (size under about 10)
before reading anything into a rate.

Server activation milestones `first_workout_started`, `first_food_logged` and `first_water_logged`
(health-service, since 2026-11-23) fire the first time the action is persisted. They are derived
from existing rows, so count distinct users, never rows.

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

## Push telemetry (2026-11-23, dev only until released)

Every FCM message the backend sends is recorded and followed sent -> delivered -> opened.

### Push payload (all sends)

Three extra STRING keys in the FCM `data` payload; the visible notification, channel,
priority and every existing data key are unchanged (no message was made data-only):

| key | value |
|---|---|
| `notification_id` | uuid v4, one per recipient token send |
| `push_type` | stable type, see below |
| `sent_at` | epoch milliseconds (string) |

### Server events (source `server`, distinct_id = recipient user id)

- `push_sent` props: `notification_id`, `push_type`, `service`, `recipient_role`
  (`customer`|`partner`, only when known), `fcm_message_id` (when FCM returns one),
  `campaign_id` (notification-service campaigns only). Emitted after FCM accepts the send.
- `push_failed` props: `notification_id`, `push_type`, `service`, `error_code` (FCM code,
  e.g. `messaging/registration-token-not-registered`), plus `recipient_role` / `campaign_id`.
- Never title, body or other content. A user with no stored token produces no event
  (no send was attempted). Telemetry is detached from the request scope and never awaited.

### Client events (source `client`; apps `phool_gobhi`, `phool_gobhi_partner`)

`push_delivered` and `push_opened`, props `notification_id`, `push_type` (both copied from
the push's data payload), `app_state` (`foreground|background|terminated|unknown`),
`seconds_since_sent` (optional, from `data.sent_at`). `nudge_opened` is retired; use
`push_opened` with `push_type` `nudge:*`.

### push_type taxonomy

| push_type | sender | recipient_role |
|---|---|---|
| `booking_confirmed`, `booking_cancelled`, `booking_completed` | booking-service | customer |
| `session_reminder` (data.type `booking_reminder`) | booking-service | customer |
| `new_booking`, `daily_briefing` | booking-service | partner |
| `gift_ready` | wallet-service | customer |
| `buddy_match`, `buddy_message` | buddy-service | customer |
| `nudge:<kind>` (`first_step`, `first_step_followup`, `comeback`, `log`, `target`, `onboarding_resume`) | health-service | customer |
| `gym_link_request` | auth-service | partner |
| `gym_link_approved`, `attendance_saas_reengagement` | auth-service | customer |
| `campaign` | notification-service (`campaign_id` in the event) | customer |

### Admin read API (booking-service, `requireRole('gobhi')`, via `/api/bookings`)

Both read BigQuery through `events_between` (deduped), cached one minute, 256 MiB cap
(a 7-day window scans about 1.5 MB). They need `ANALYTICS_READ_PROVIDER=bigquery`
(else 503). Bad `days`/`platform`/`role`/`type` is a 400.

`GET /api/bookings/admin/analytics/push-funnel?days=7|30|90&type=&platform=ios|android&role=customer|partner|gobhi`
(`days` default 30; all filters optional)

```json
{"data":{"days":30,"generatedAt":"2026-11-23T12:00:00.000Z",
 "totals":{"sent":4,"failed":1,"delivered":3,"opened":2,"deliveredRate":0.75,"openRate":0.5,"openOfDeliveredRate":0.6667},
 "byType":[{"type":"booking_confirmed","sent":2,"failed":0,"delivered":2,"opened":2,"deliveredRate":1,"openRate":1}],
 "byDay":[{"date":"2026-11-22","sent":4,"delivered":3,"opened":2}],
 "byPlatform":[{"platform":"android","sent":2,"delivered":2,"opened":1},{"platform":"ios","sent":2,"delivered":1,"opened":1}],
 "timeToOpenSeconds":{"p50":120,"p90":240,"count":2},
 "failuresByCode":[{"code":"messaging/registration-token-not-registered","count":1}]}}
```

`GET /api/bookings/admin/analytics/push-types?days=7|30|90` (filter dropdown, most-sent first)

```json
{"data":{"days":30,"generatedAt":"2026-11-23T12:00:00.000Z","types":[{"type":"booking_confirmed","sent":2},{"type":"nudge:comeback","sent":1}]}}
```

Rules: `sent` = notification_ids FCM accepted; `failed` = notification_ids FCM rejected
(not in `sent`, so rates use `sent` as the denominator). Each notification_id counts once
per stage. `delivered` and `opened` only count rows whose `push_sent` is in the window; an
open with no delivered row counts as delivered. Rates are 0-1, 4 decimals, 0 when the
denominator is 0. `byDay` is the IST calendar day of the send. `platform` comes from the
notification's own client event, else the recipient's latest platform on any push client
event in the window, else `unknown` (so `unknown` is large until the apps ship receipts).
`timeToOpenSeconds` is send -> first open (only opens at or after the send).

### Limits of "delivered"

The backend only knows FCM accepted the message (`push_sent`). `push_delivered` is a
client event, and the OS shows a visible notification without running app code, so a
killed or backgrounded app (especially iOS) may never report delivery: `delivered` is a
lower bound, and `opened` is the reliable stage. Users who disabled notifications or whose
token is stale still count as sent until FCM reports an error on a later send. Sends
from before this release have no `notification_id` and are not in any report.

## Notification permission report (muted users)

The server cannot see that a user muted the app in OS settings (FCM still accepts the
send), so the apps report it: client event `notification_permission_status`, once a day per
signed-in install, props `status` (`granted`|`denied`|`not_determined`|`provisional`) and
`source` (`launch`|`resume`), plus the standard `platform` and `app`
(`phool_gobhi`|`phool_gobhi_partner`). `denied` = muted.

`GET /api/bookings/admin/analytics/notification-permission?days=7|14|30&platform=ios|android&app=customer|partner`
(booking-service, `requireRole('gobhi')`; `days` default 14, filters optional; bad values
400; 503 unless `ANALYTICS_READ_PROVIDER=bigquery`). Same numbers from the CLI:
`ANALYTICS_ENVIRONMENT=prod node scripts/notification-permission.cjs --days 14 [--platform ios] [--app partner] [--json]`.

```json
{"data":{"days":14,"generatedAt":"2026-11-24T12:00:00.000Z","reportingUsers":12,"mutedUsers":3,"mutedRate":0.25,
 "byStatus":[{"status":"granted","users":6},{"status":"denied","users":3},{"status":"not_determined","users":2},{"status":"provisional","users":1}],
 "byPlatform":[{"platform":"android","granted":6,"denied":2,"not_determined":0,"provisional":0},{"platform":"ios","granted":0,"denied":1,"not_determined":0,"provisional":1},{"platform":"unknown","granted":0,"denied":0,"not_determined":2,"provisional":0}],
 "byApp":[{"app":"customer","granted":6,"denied":3,"not_determined":0,"provisional":0},{"app":"partner","granted":0,"denied":0,"not_determined":2,"provisional":1}],
 "lastReportAt":"2026-11-24T11:30:00Z"}}
```

Semantics:
- Reads `events_between` (deduped). Anonymous `anon_` ids and rows with an unknown status or
  an app other than the two above are ignored.
- Each person (distinct_id = user id) counts once, by their LATEST event inside the window.
  Filters apply to events first, then the latest is taken, so a person on both apps with no
  `app` filter counts once, under the app of their latest report (`byApp` and `byPlatform`
  each sum to `reportingUsers`).
- `mutedUsers` = latest status `denied`; `mutedRate` = mutedUsers / reportingUsers (0 when none).
  `byStatus` always lists all four statuses. A `platform` other than ios/android becomes
  `unknown`. `lastReportAt` is the newest report in the window, null if none.
- Limits: only users on an app version that sends the event appear, and only if they opened
  the app in the window (a user who muted and never returns is not seen). It counts people,
  not FCM tokens, and says nothing about per-channel mutes. Read the numbers against the app
  release date: right after the rollout `reportingUsers` is only the updated fraction of users.
  A 14-day window scans on the order of MBs.
