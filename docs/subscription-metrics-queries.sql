-- Offer and membership events are not emitted yet, so these queries are
-- untested until those features ship.
-- Run in asia-south1 against analytics_dev. Use analytics_prod for production.
-- Bind @start_at and @end_at as UTC TIMESTAMPs for the reporting window [start, end).
-- Bind @as_of as the UTC TIMESTAMP through which follow-up data is available.
-- The warehouse function includes its end timestamp, so reporting queries
-- explicitly exclude @end_at. Follow-up scans can extend past the cohort window.

-- 1. Seven-day activation. Count a purchaser once, with activation credited
-- if any of their purchases with a complete follow-up has a qualifying log.
WITH purchases AS (
  SELECT distinct_id, ts
  FROM `phool-gobhi.analytics_dev.events_between`(@start_at, @end_at, ['offer_purchased'])
  WHERE ts < @end_at
    AND TIMESTAMP_ADD(ts, INTERVAL 7 DAY) <= @as_of
    AND distinct_id IS NOT NULL
),
activation_logs AS (
  SELECT distinct_id, ts
  FROM `phool-gobhi.analytics_dev.events_between`(
    @start_at,
    LEAST(@as_of, TIMESTAMP_ADD(@end_at, INTERVAL 7 DAY)),
    ['first_food_logged', 'first_workout_started', 'first_water_logged', 'health_report_uploaded']
  )
)
SELECT
  COUNT(DISTINCT p.distinct_id) AS purchasers,
  COUNT(DISTINCT l.distinct_id) AS activated_purchasers,
  SAFE_DIVIDE(COUNT(DISTINCT l.distinct_id), COUNT(DISTINCT p.distinct_id)) AS activation_rate
FROM purchases AS p
LEFT JOIN activation_logs AS l
  ON l.distinct_id = p.distinct_id
  AND l.ts >= p.ts
  AND l.ts <= TIMESTAMP_ADD(p.ts, INTERVAL 7 DAY);

-- 2. Logging retention. Start with each user's first purchase of a family in
-- the report window, so renewals in that window do not reset their clock.
-- Week 1 is days [0, 7), week 4 is [21, 28), and so on.
-- The NULL week_number row measures retention across all three weeks,
-- using only users with a full 12 weeks of follow-up.
WITH purchases AS (
  SELECT distinct_id, JSON_VALUE(properties, '$.family') AS family, MIN(ts) AS purchased_at
  FROM `phool-gobhi.analytics_dev.events_between`(@start_at, @end_at, ['offer_purchased'])
  WHERE ts < @end_at AND distinct_id IS NOT NULL
  GROUP BY distinct_id, family
),
logging_events AS (
  SELECT distinct_id, ts
  FROM `phool-gobhi.analytics_dev.events_between`(
    @start_at,
    LEAST(@as_of, TIMESTAMP_ADD(@end_at, INTERVAL 84 DAY)),
    ['health_food_logged', 'workout_finished', 'water_logged', 'supplement_logged', 'health_report_uploaded']
  )
),
user_weeks AS (
  SELECT
    p.distinct_id,
    p.family,
    week.week_number,
    COUNT(l.ts) > 0 AS logged
  FROM purchases AS p
  CROSS JOIN UNNEST([
    STRUCT(4 AS week_number, 21 AS start_day, 28 AS end_day),
    STRUCT(8 AS week_number, 49 AS start_day, 56 AS end_day),
    STRUCT(12 AS week_number, 77 AS start_day, 84 AS end_day)
  ]) AS week
  LEFT JOIN logging_events AS l
    ON l.distinct_id = p.distinct_id
    AND l.ts >= TIMESTAMP_ADD(p.purchased_at, INTERVAL week.start_day DAY)
    AND l.ts < TIMESTAMP_ADD(p.purchased_at, INTERVAL week.end_day DAY)
  WHERE TIMESTAMP_ADD(p.purchased_at, INTERVAL week.end_day DAY) <= @as_of
  GROUP BY p.distinct_id, p.family, week_number
),
users_with_full_follow_up AS (
  SELECT family, distinct_id, LOGICAL_AND(logged) AS logged
  FROM user_weeks
  GROUP BY family, distinct_id
  HAVING COUNT(*) = 3
),
retention_rows AS (
  SELECT family, week_number, logged FROM user_weeks
  UNION ALL
  SELECT family, CAST(NULL AS INT64), logged FROM users_with_full_follow_up
)
SELECT
  family,
  week_number,
  COUNT(*) AS eligible_users,
  COUNTIF(logged) AS logging_users,
  SAFE_DIVIDE(COUNTIF(logged), COUNT(*)) AS logging_retention_rate
FROM retention_rows
GROUP BY family, week_number
ORDER BY family, week_number NULLS LAST;

-- 3. Model-training consent. Count prompt and grant occurrences in the same
-- reporting window, as defined by the consent_prompt_shown registry entry.
WITH totals AS (
  SELECT
    COUNTIF(event = 'model_training_consent_granted') AS grants,
    COUNTIF(
      event = 'consent_prompt_shown' AND JSON_VALUE(properties, '$.consent_kind') = 'model_training'
    ) AS prompts
  FROM `phool-gobhi.analytics_dev.events_between`(
    @start_at, @end_at, ['consent_prompt_shown', 'model_training_consent_granted']
  )
  WHERE ts < @end_at
)
SELECT grants, prompts, SAFE_DIVIDE(grants, prompts) AS consent_rate
FROM totals;

-- 4. Purchase funnel volume per offer and region, plus per-offer totals.
-- offer_viewed, offer_quote_created and offer_purchased all carry region.
WITH funnel_events AS (
  SELECT
    event,
    JSON_VALUE(properties, '$.offer_key') AS offer_key,
    JSON_VALUE(properties, '$.region') AS region
  FROM `phool-gobhi.analytics_dev.events_between`(
    @start_at, @end_at, ['offer_viewed', 'offer_quote_created', 'offer_purchased']
  )
  WHERE ts < @end_at
)
SELECT
  offer_key,
  region,
  GROUPING(region) = 1 AS is_offer_total,
  COUNTIF(event = 'offer_viewed') AS views,
  COUNTIF(event = 'offer_quote_created') AS quotes,
  COUNTIF(event = 'offer_purchased') AS purchases
FROM funnel_events
WHERE offer_key IS NOT NULL
GROUP BY GROUPING SETS ((offer_key, region), (offer_key))
ORDER BY offer_key, is_offer_total, region;

-- 5. Visits per member per term. Include completed terms that started in the
-- cohort window, with zero visits retained. Terms use [activated_at, ends_at).
WITH activations AS (
  SELECT
    event_id AS term_id,
    distinct_id,
    JSON_VALUE(properties, '$.offer_key') AS offer_key,
    ts AS activated_at,
    SAFE_CAST(JSON_VALUE(properties, '$.ends_at') AS TIMESTAMP) AS ends_at
  FROM `phool-gobhi.analytics_dev.events_between`(@start_at, @end_at, ['membership_activated'])
  WHERE ts < @end_at AND distinct_id IS NOT NULL
),
terms AS (
  SELECT *
  FROM activations
  WHERE ends_at > activated_at AND ends_at <= @as_of
),
visits AS (
  SELECT event_id, distinct_id, ts
  FROM `phool-gobhi.analytics_dev.events_between`(
    @start_at, @as_of, ['membership_visit_checked_in']
  )
)
SELECT
  t.term_id,
  t.distinct_id,
  t.offer_key,
  t.activated_at,
  t.ends_at,
  COUNT(v.event_id) AS visit_count
FROM terms AS t
LEFT JOIN visits AS v
  ON v.distinct_id = t.distinct_id AND v.ts >= t.activated_at AND v.ts < t.ends_at
GROUP BY t.term_id, t.distinct_id, t.offer_key, t.activated_at, t.ends_at
ORDER BY t.activated_at, t.term_id;
