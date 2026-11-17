# Traffic and engagement report

`GET /api/bookings/admin/analytics/traffic` is staff-only (`gobhi`). Query parameters:

- `product`: `all` (default), `customer`, `partner`, `website`.
- `platform`: `both` (default), `android`, `ios`. Applies to customer/partner only.
- `days`: integer 1–365, default 30. Controls charts and engagement summaries.

The admin Analytics → Traffic view uses this endpoint. Deploy booking-service before the admin update. The existing `website-traffic` endpoint is retained for acquisition/source/geo details, displayed only for Website. Geo filters apply to that acquisition section, not to the new activity report.

## Definitions

The report reads client events only, with recognised product tags (`phool_gobhi`/`customer`, `phool_gobhi_partner`/`partner`, `website`) and a nonempty distinct identity. The literal `anonymous`, `identify`, `loading_wait_ended` and `explore_queue_*` diagnostics are excluded. Server jobs and server business events cannot inflate activity counts.

An active identity has at least one qualifying event. DAU/WAU/MAU are distinct identities over rolling 24-hour, 7-day and 30-day windows ending at `asOf`, regardless of `days`. `asOf` is rounded down to the current minute so the warehouse's existing one-minute cache can be reused. Each query scans `max(30, days)` days. Calendar charts, return frequency and weekday/hour patterns use Asia/Kolkata. Partial boundary dates are labelled in the UI.

Identities are product scoped (`product:distinct_id`). A person using two products may count twice under All. There is no cross-product identity graph or anonymous-to-login stitching in this report; the latter can also increase counts. Platform breakdowns can overlap for the same identity. Mobile Both means Android + iOS. Missing platform tags remain visible in All, rather than being assigned to an OS.

## Engagement estimate

Current telemetry does **not** consistently capture foreground/visibility intervals across products. The report must not present historical session spans as exact foreground engagement.

- Events with session IDs are ordered within product/platform/session.
- An inactivity gap over 30 minutes starts a new visit, even if a cold-start/tab session ID is reused.
- Consecutive event gaps of 0–300 seconds contribute observed engagement seconds; longer gaps contribute zero.
- There is no guessed duration after the final event. Single-event visits have zero observed time.
- Time is assigned to the most recent `screen_viewed` screen in the visit, carried through intervening action events. Time before the first screen cannot be assigned to a screen.
- Events without session IDs still contribute to active users, views, actions and calendar patterns, but not time/session counts. The UI reports event session-ID coverage and sessions with positive observed time.
- Average per session divides observed seconds by all tracked visits (including visits with zero observed time). Average per identity divides observed seconds by all active identities, so incomplete session coverage can understate it.

For precise future foreground time, instrument lifecycle/visibility intervals or foreground heartbeats consistently in all clients. Historical exact foreground time cannot be reconstructed from existing event timestamps.

## Patterns

The response includes daily active identities/views, per-product/platform counts, screens ranked by observed seconds then views, actions ranked by identity reach then count, active IST dates per identity, engagement-duration buckets, and an IST weekday/hour grid. The grid deduplicates identities within each recurring slot across weeks; it is not an average daily attendance chart.

## Validation

`node --test services/booking-service/test/trafficReport.test.js` executes the relational report against in-memory SQLite fixtures, adapting only PostgreSQL date/timestamp syntax. It covers platform/product slices, independent activity windows, product-scoped identity counts, idle gaps, screen attribution, missing sessions, diagnostics, IST boundaries and bound query parameters. This is not a substitute for a BigQuery dry run against the deployment project.

`trafficReport.js` emits native BigQuery SQL through the existing bounded, cost-capped warehouse client, and PostgreSQL SQL for the legacy read provider. The new report does not extend the older SQL compatibility translator.
