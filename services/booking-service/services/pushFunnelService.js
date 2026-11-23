// Push-notification funnel for the admin dashboard. Reads the four push events
// (push_sent / push_failed from the backend, push_delivered / push_opened from the
// apps) through the deduplicating events_between function and joins them on
// notification_id. One bounded BigQuery query per report; queryBigQuery adds the
// one-minute cache and the 256 MiB per-query cap.
//
// Counting rules (documented in docs/analytics-bigquery-runbook.md):
//  - every stage counts a notification_id at most once;
//  - delivered/opened only count when the matching push_sent is in the window;
//  - an opened notification with no delivered row still counts as delivered;
//  - platform = the platform on the notification's own client event, else the
//    recipient's latest platform on any push client event in the window, else 'unknown'.
import { queryBigQuery } from '../utils/bigQueryAnalytics.js';
import { analyticsEnvironment } from '../utils/analyticsTransport.js';

export const PUSH_DAYS = [7, 30, 90];
const PLATFORMS = ['ios', 'android'];
const ROLES = ['customer', 'partner', 'gobhi'];
const TYPE_RE = /^[a-z0-9_:.\-]{1,100}$/i;
const PUSH_EVENTS = ['push_sent', 'push_failed', 'push_delivered', 'push_opened'];

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function pushFilters(input = {}) {
  const days = input.days === undefined || input.days === '' ? 30 : Number(input.days);
  if (!PUSH_DAYS.includes(days)) throw bad('days must be 7, 30 or 90');
  const type = input.type ? String(input.type) : '';
  if (type && !TYPE_RE.test(type)) throw bad('invalid push type');
  const platform = input.platform ? String(input.platform).toLowerCase() : '';
  if (platform && !PLATFORMS.includes(platform)) throw bad('platform must be ios or android');
  const role = input.role ? String(input.role).toLowerCase() : '';
  if (role && !ROLES.includes(role)) throw bad('role must be customer, partner or gobhi');
  return { days, type, platform, role };
}

const table = (project, dataset) => `\`${project}.${dataset}.events_between\`(TIMESTAMP(@p1), TIMESTAMP(@p2), ARRAY<STRING>[${PUSH_EVENTS.map(name => `'${name}'`).join(',')}])`;
const params = (values) => values.map((value, index) => ({ name: `p${index + 1}`, parameterType: { type: 'STRING' }, parameterValue: { value: String(value) } }));
const checkWarehouse = (project, dataset) => {
  if (!/^[a-z][a-z0-9-]+$/.test(project) || !/^analytics_(dev|prod)$/.test(dataset)) throw new Error('Invalid push warehouse');
};

export function buildPushFunnelQuery(input = {}, { asOf = new Date(), project = 'phool-gobhi', dataset = 'analytics_dev' } = {}) {
  const filters = pushFilters(input);
  checkWarehouse(project, dataset);
  const end = new Date(asOf);
  const start = new Date(end.getTime() - filters.days * 86400000);
  const sql = `WITH ev AS (
    SELECT ts, event, source, distinct_id,
      JSON_VALUE(properties, '$.notification_id') AS nid,
      JSON_VALUE(properties, '$.push_type') AS push_type,
      JSON_VALUE(properties, '$.recipient_role') AS role,
      JSON_VALUE(properties, '$.error_code') AS error_code,
      LOWER(JSON_VALUE(properties, '$.platform')) AS platform
    FROM ${table(project, dataset)}
    WHERE ts >= TIMESTAMP(@p1) AND ts < TIMESTAMP(@p2)
  ), client AS (
    SELECT nid, MIN(IF(event = 'push_delivered', ts, NULL)) AS delivered_ts, MIN(IF(event = 'push_opened', ts, NULL)) AS opened_ts,
      ARRAY_AGG(IF(platform IN ('ios', 'android'), platform, NULL) IGNORE NULLS ORDER BY ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS platform
    FROM ev WHERE event IN ('push_delivered', 'push_opened') AND nid IS NOT NULL GROUP BY nid
  ), user_platform AS (
    SELECT distinct_id, ARRAY_AGG(IF(platform IN ('ios', 'android'), platform, NULL) IGNORE NULLS ORDER BY ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS platform
    FROM ev WHERE event IN ('push_delivered', 'push_opened') GROUP BY distinct_id
  ), sent AS (
    SELECT nid, ARRAY_AGG(STRUCT(ts, distinct_id, push_type, role) ORDER BY ts LIMIT 1)[OFFSET(0)] AS r
    FROM ev WHERE event = 'push_sent' AND nid IS NOT NULL GROUP BY nid
  ), failed AS (
    SELECT nid, ARRAY_AGG(STRUCT(ts, distinct_id, push_type, role, error_code) ORDER BY ts LIMIT 1)[OFFSET(0)] AS r
    FROM ev WHERE event = 'push_failed' AND nid IS NOT NULL GROUP BY nid
  ), base AS (
    SELECT s.r.push_type AS push_type, s.r.role AS role, s.r.ts AS ts, 1 AS is_sent, 0 AS is_failed, CAST(NULL AS STRING) AS code,
      c.delivered_ts, c.opened_ts, COALESCE(c.platform, u.platform, 'unknown') AS platform
    FROM sent s LEFT JOIN client c ON c.nid = s.nid LEFT JOIN user_platform u ON u.distinct_id = s.r.distinct_id
    UNION ALL
    SELECT f.r.push_type, f.r.role, f.r.ts, 0, 1, COALESCE(f.r.error_code, 'unknown'),
      CAST(NULL AS TIMESTAMP), CAST(NULL AS TIMESTAMP), COALESCE(u.platform, 'unknown')
    FROM failed f LEFT JOIN user_platform u ON u.distinct_id = f.r.distinct_id
  ), f AS (
    SELECT *, COALESCE(push_type, 'unknown') AS type,
      FORMAT_TIMESTAMP('%Y-%m-%d', ts, 'Asia/Kolkata') AS day,
      IF(is_sent = 1 AND (delivered_ts IS NOT NULL OR opened_ts IS NOT NULL), 1, 0) AS is_delivered,
      IF(is_sent = 1 AND opened_ts IS NOT NULL, 1, 0) AS is_opened,
      IF(is_sent = 1 AND opened_ts >= ts, TIMESTAMP_DIFF(opened_ts, ts, MILLISECOND) / 1000.0, NULL) AS open_seconds
    FROM base
    WHERE (@p3 = '' OR COALESCE(push_type, 'unknown') = @p3) AND (@p4 = '' OR platform = @p4) AND (@p5 = '' OR role = @p5)
  ), results AS (
    SELECT 'total' AS kind, '' AS label, SUM(is_sent) AS sent, SUM(is_failed) AS failed, SUM(is_delivered) AS delivered, SUM(is_opened) AS opened,
      CAST(NULL AS FLOAT64) AS p50, CAST(NULL AS FLOAT64) AS p90, CAST(NULL AS INT64) AS n FROM f
    UNION ALL
    SELECT 'type', type, SUM(is_sent), SUM(is_failed), SUM(is_delivered), SUM(is_opened), NULL, NULL, NULL FROM f GROUP BY type
    UNION ALL
    SELECT 'day', day, SUM(is_sent), SUM(is_failed), SUM(is_delivered), SUM(is_opened), NULL, NULL, NULL FROM f GROUP BY day
    UNION ALL
    SELECT 'platform', platform, SUM(is_sent), SUM(is_failed), SUM(is_delivered), SUM(is_opened), NULL, NULL, NULL FROM f WHERE is_sent = 1 GROUP BY platform
    UNION ALL
    SELECT 'open_time', '', NULL, NULL, NULL, NULL, APPROX_QUANTILES(open_seconds, 100)[SAFE_OFFSET(50)], APPROX_QUANTILES(open_seconds, 100)[SAFE_OFFSET(90)],
      COUNT(open_seconds) FROM f WHERE open_seconds IS NOT NULL
    UNION ALL
    SELECT 'failure', code, NULL, COUNT(*), NULL, NULL, NULL, NULL, NULL FROM f WHERE is_failed = 1 GROUP BY code
  )
  SELECT * FROM results`;
  const queryParameters = params([start.toISOString(), end.toISOString(), filters.type, filters.platform, filters.role]);
  return { sql, queryParameters, filters, start, end };
}

export function buildPushTypesQuery(input = {}, { asOf = new Date(), project = 'phool-gobhi', dataset = 'analytics_dev' } = {}) {
  const { days } = pushFilters({ days: input.days });
  checkWarehouse(project, dataset);
  const end = new Date(asOf);
  const start = new Date(end.getTime() - days * 86400000);
  const sql = `SELECT COALESCE(JSON_VALUE(properties, '$.push_type'), 'unknown') AS type,
      COUNT(DISTINCT JSON_VALUE(properties, '$.notification_id')) AS sent
    FROM \`${project}.${dataset}.events_between\`(TIMESTAMP(@p1), TIMESTAMP(@p2), ARRAY<STRING>['push_sent'])
    WHERE ts >= TIMESTAMP(@p1) AND ts < TIMESTAMP(@p2)
    GROUP BY type ORDER BY sent DESC, type`;
  return { sql, queryParameters: params([start.toISOString(), end.toISOString()]), days, start, end };
}

const num = (value) => Number(value) || 0;
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : 0);
const stages = (row) => ({ sent: num(row.sent), failed: num(row.failed), delivered: num(row.delivered), opened: num(row.opened) });

export function pushFunnelReport(rows, { filters, generatedAt = new Date() }) {
  const empty = { sent: 0, failed: 0, delivered: 0, opened: 0 };
  const total = stages(rows.find(row => row.kind === 'total') || empty);
  const openTime = rows.find(row => row.kind === 'open_time') || {};
  const withRates = (row) => ({ ...row, deliveredRate: rate(row.delivered, row.sent), openRate: rate(row.opened, row.sent) });
  const seconds = (value) => (value == null ? null : Math.round(num(value) * 10) / 10);
  return {
    days: filters.days,
    generatedAt: generatedAt.toISOString(),
    totals: { ...total, deliveredRate: rate(total.delivered, total.sent), openRate: rate(total.opened, total.sent),
      openOfDeliveredRate: rate(total.opened, total.delivered) },
    byType: rows.filter(row => row.kind === 'type').map(row => withRates({ type: row.label, ...stages(row) }))
      .sort((a, b) => b.sent - a.sent || b.failed - a.failed || a.type.localeCompare(b.type)),
    byDay: rows.filter(row => row.kind === 'day').map(row => ({ date: row.label, sent: num(row.sent), delivered: num(row.delivered), opened: num(row.opened) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byPlatform: rows.filter(row => row.kind === 'platform').map(row => ({ platform: row.label, sent: num(row.sent), delivered: num(row.delivered), opened: num(row.opened) }))
      .sort((a, b) => b.sent - a.sent || a.platform.localeCompare(b.platform)),
    timeToOpenSeconds: { p50: seconds(openTime.p50), p90: seconds(openTime.p90), count: num(openTime.n) },
    failuresByCode: rows.filter(row => row.kind === 'failure').map(row => ({ code: row.label, count: num(row.failed) }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

function context() {
  return {
    asOf: new Date(Math.floor(Date.now() / 60000) * 60000),
    project: process.env.ANALYTICS_BIGQUERY_PROJECT || 'phool-gobhi',
    dataset: process.env.ANALYTICS_BIGQUERY_DATASET || `analytics_${analyticsEnvironment()}`,
  };
}

function requireWarehouse() {
  if (process.env.ANALYTICS_READ_PROVIDER !== 'bigquery') {
    throw Object.assign(new Error('Push analytics requires the BigQuery analytics provider'), { status: 503 });
  }
}

export async function getPushFunnel(input = {}, { query = queryBigQuery } = {}) {
  const built = buildPushFunnelQuery(input, context());
  requireWarehouse();
  const result = await query(built.sql, [], { native: true, queryParameters: built.queryParameters });
  return pushFunnelReport(result.rows, { filters: built.filters, generatedAt: new Date() });
}

export async function getPushTypes(input = {}, { query = queryBigQuery } = {}) {
  const built = buildPushTypesQuery(input, context());
  requireWarehouse();
  const result = await query(built.sql, [], { native: true, queryParameters: built.queryParameters });
  return { days: built.days, generatedAt: new Date().toISOString(),
    types: result.rows.map(row => ({ type: row.type, sent: num(row.sent) })) };
}
