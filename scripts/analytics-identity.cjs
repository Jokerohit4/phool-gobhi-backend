// Shared GoogleSQL building blocks for the app-vs-web analytics reports.
//
// Facts these encode (see docs/analytics-bigquery-runbook.md, "App vs web"):
//  - Client events carry properties.platform = ios | android | web. Server events carry none.
//  - Anonymous devices (distinct_id `anon_...`) are linked to a user by an `identify` event
//    whose properties.anon_distinct_id is the device id; logged-in events use the numeric user id.
//  - So a "person" is the user id when the device was identified, else the raw distinct_id.
//
// Use inside a query that reads WAREHOUSE_EVENTS (replaced by analytics-client with the
// deduping events_between() table function, so counts are never raw duplicates).
exports.IDENTITY_CTES = `
raw AS (
  SELECT event, distinct_id, ts,
         JSON_VALUE(properties,'$.platform') AS plat,
         JSON_VALUE(properties,'$.anon_distinct_id') AS anon
  FROM WAREHOUSE_EVENTS WHERE distinct_id IS NOT NULL
),
idmap AS (
  SELECT anon, MIN(distinct_id) AS uid FROM raw WHERE event='identify' AND anon IS NOT NULL GROUP BY anon
),
ev AS (
  SELECT r.event, r.ts, COALESCE(m.uid, r.distinct_id) AS person, r.plat
  FROM raw r LEFT JOIN idmap m ON r.distinct_id = m.anon
),
person_platform AS (
  -- First client-reported platform, preferring ios/android over web when a person has both.
  SELECT person,
         ARRAY_AGG(plat IGNORE NULLS ORDER BY IF(plat IN ('ios','android'),0,1), ts LIMIT 1)[SAFE_OFFSET(0)] AS plat
  FROM ev WHERE plat IN ('ios','android','web') GROUP BY person
)`;

// Events that must not count as "the user came back" (bookkeeping, not engagement).
exports.NON_ENGAGEMENT_EVENTS = ['identify', 'signup_completed', 'login_completed'];

exports.IST = 'Asia/Kolkata';

// Group label used in reports: app = ios + android.
exports.groupOf = (plat) => (plat === 'ios' || plat === 'android' ? 'app' : plat === 'web' ? 'web' : 'unknown');
