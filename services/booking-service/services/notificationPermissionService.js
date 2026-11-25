// How many people have muted notifications (OS permission = denied), for the admin
// dashboard. Reads the client event `notification_permission_status` through the
// deduplicating events_between function, takes each person's LATEST event inside the
// window and counts them. One bounded BigQuery query; queryBigQuery adds the
// one-minute cache and the 256 MiB per-query cap. Semantics: docs/analytics-bigquery-runbook.md.
import { queryBigQuery } from '../utils/bigQueryAnalytics.js';
import { analyticsEnvironment } from '../utils/analyticsTransport.js';

export const PERMISSION_DAYS = [7, 14, 30];
export const PERMISSION_STATUSES = ['granted', 'denied', 'not_determined', 'provisional'];
const PLATFORMS = ['ios', 'android'];
const APP_IDS = { customer: 'phool_gobhi', partner: 'phool_gobhi_partner' };
const EVENT = 'notification_permission_status';

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function permissionFilters(input = {}) {
  const days = input.days === undefined || input.days === '' ? 14 : Number(input.days);
  if (!PERMISSION_DAYS.includes(days)) throw bad('days must be 7, 14 or 30');
  const platform = input.platform ? String(input.platform).toLowerCase() : '';
  if (platform && !PLATFORMS.includes(platform)) throw bad('platform must be ios or android');
  const app = input.app ? String(input.app).toLowerCase() : '';
  if (app && !APP_IDS[app]) throw bad('app must be customer or partner');
  return { days, platform, app };
}

const params = (values) => values.map((value, index) => ({ name: `p${index + 1}`, parameterType: { type: 'STRING' }, parameterValue: { value: String(value) } }));
const checkWarehouse = (project, dataset) => {
  if (!/^[a-z][a-z0-9-]+$/.test(project) || !/^analytics_(dev|prod)$/.test(dataset)) throw new Error('Invalid permission warehouse');
};

export function buildPermissionQuery(input = {}, { asOf = new Date(), project = 'phool-gobhi', dataset = 'analytics_dev' } = {}) {
  const filters = permissionFilters(input);
  checkWarehouse(project, dataset);
  const end = new Date(asOf);
  const start = new Date(end.getTime() - filters.days * 86400000);
  const sql = `WITH ev AS (
    SELECT ts, distinct_id, JSON_VALUE(properties, '$.status') AS status,
      IF(LOWER(JSON_VALUE(properties, '$.platform')) IN ('ios', 'android'), LOWER(JSON_VALUE(properties, '$.platform')), 'unknown') AS platform,
      CASE JSON_VALUE(properties, '$.app') WHEN 'phool_gobhi' THEN 'customer' WHEN 'phool_gobhi_partner' THEN 'partner' END AS app
    FROM \`${project}.${dataset}.events_between\`(TIMESTAMP(@p1), TIMESTAMP(@p2), ARRAY<STRING>['${EVENT}'])
    WHERE event = '${EVENT}' AND ts >= TIMESTAMP(@p1) AND ts < TIMESTAMP(@p2)
      AND distinct_id IS NOT NULL AND NOT STARTS_WITH(distinct_id, 'anon_')
  ), scoped AS (
    SELECT * FROM ev
    WHERE status IN ('granted', 'denied', 'not_determined', 'provisional') AND app IS NOT NULL
      AND (@p3 = '' OR platform = @p3) AND (@p4 = '' OR app = @p4)
  ), latest AS (
    SELECT * FROM scoped QUALIFY ROW_NUMBER() OVER (PARTITION BY distinct_id ORDER BY ts DESC) = 1
  )
  SELECT platform, app, status, COUNT(*) AS users, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(ts)) AS last_report
  FROM latest GROUP BY platform, app, status`;
  const queryParameters = params([start.toISOString(), end.toISOString(), filters.platform, APP_IDS[filters.app] ? filters.app : '']);
  return { sql, queryParameters, filters, start, end };
}

const num = (value) => Number(value) || 0;
const zeroes = () => Object.fromEntries(PERMISSION_STATUSES.map(status => [status, 0]));

export function permissionReport(rows, { filters, generatedAt = new Date() }) {
  const byStatus = zeroes();
  const platforms = new Map([['android', zeroes()], ['ios', zeroes()], ['unknown', zeroes()]]);
  const apps = new Map([['customer', zeroes()], ['partner', zeroes()]]);
  let last = null;
  for (const row of rows) {
    if (!PERMISSION_STATUSES.includes(row.status)) continue;
    const users = num(row.users);
    byStatus[row.status] += users;
    if (!platforms.has(row.platform)) platforms.set(row.platform, zeroes());
    platforms.get(row.platform)[row.status] += users;
    if (apps.has(row.app)) apps.get(row.app)[row.status] += users;
    if (row.last_report && (!last || row.last_report > last)) last = row.last_report;
  }
  const reportingUsers = PERMISSION_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
  const mutedUsers = byStatus.denied;
  return {
    days: filters.days,
    generatedAt: generatedAt.toISOString(),
    reportingUsers,
    mutedUsers,
    mutedRate: reportingUsers > 0 ? Math.round((mutedUsers / reportingUsers) * 10000) / 10000 : 0,
    byStatus: PERMISSION_STATUSES.map(status => ({ status, users: byStatus[status] })),
    byPlatform: [...platforms].map(([platform, counts]) => ({ platform, ...counts })),
    byApp: [...apps].map(([app, counts]) => ({ app, ...counts })),
    lastReportAt: last,
  };
}

export async function getNotificationPermission(input = {}, { query = queryBigQuery } = {}) {
  const built = buildPermissionQuery(input, {
    asOf: new Date(Math.floor(Date.now() / 60000) * 60000),
    project: process.env.ANALYTICS_BIGQUERY_PROJECT || 'phool-gobhi',
    dataset: process.env.ANALYTICS_BIGQUERY_DATASET || `analytics_${analyticsEnvironment()}`,
  });
  if (process.env.ANALYTICS_READ_PROVIDER !== 'bigquery') {
    throw Object.assign(new Error('Notification permission analytics requires the BigQuery analytics provider'), { status: 503 });
  }
  const result = await query(built.sql, [], { native: true, queryParameters: built.queryParameters });
  return permissionReport(result.rows, { filters: built.filters, generatedAt: new Date() });
}
