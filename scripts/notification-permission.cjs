#!/usr/bin/env node
/*
 * Notification permission report (warehouse, read-only): how many people have muted the app.
 *
 *   ANALYTICS_ENVIRONMENT=prod node scripts/notification-permission.cjs [--days 7|14|30]
 *        [--platform ios|android] [--app customer|partner] [--json]
 *
 * Takes each person's LATEST `notification_permission_status` client event inside the window
 * (anonymous anon_ ids ignored), then counts. `denied` = muted in OS settings. Only users on an
 * app version that reports the event appear; this is not the FCM token count.
 * Same numbers as GET /api/bookings/admin/analytics/notification-permission.
 */
const { warehouseClient } = require('./analytics-client.cjs');

const STATUSES = ['granted', 'denied', 'not_determined', 'provisional'];
const APP_IDS = { customer: 'phool_gobhi', partner: 'phool_gobhi_partner' };

function parseArgs(argv) {
  const out = { days: 14, platform: '', app: '', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--platform') out.platform = String(argv[++i] || '').toLowerCase();
    else if (a === '--app') out.app = String(argv[++i] || '').toLowerCase();
    else throw Error(`Unknown argument: ${a}`);
  }
  if (![7, 14, 30].includes(out.days)) throw Error('--days must be 7, 14 or 30');
  if (out.platform && !['ios', 'android'].includes(out.platform)) throw Error('--platform must be ios or android');
  if (out.app && !APP_IDS[out.app]) throw Error('--app must be customer or partner');
  return out;
}

function buildSql({ days, platform, app }) {
  // days/platform/app are validated enums above, so inlining them is safe.
  return `
WITH ev AS (
  SELECT ts, distinct_id, JSON_VALUE(properties, '$.status') AS status,
    IF(LOWER(JSON_VALUE(properties, '$.platform')) IN ('ios', 'android'), LOWER(JSON_VALUE(properties, '$.platform')), 'unknown') AS platform,
    CASE JSON_VALUE(properties, '$.app') WHEN 'phool_gobhi' THEN 'customer' WHEN 'phool_gobhi_partner' THEN 'partner' END AS app
  FROM WAREHOUSE_EVENTS
  WHERE event = 'notification_permission_status'
    AND ts >= TIMESTAMP_SUB(@as_of, INTERVAL ${days} DAY) AND ts < @as_of
    AND distinct_id IS NOT NULL AND NOT STARTS_WITH(distinct_id, 'anon_')
), scoped AS (
  SELECT * FROM ev
  WHERE status IN ('granted', 'denied', 'not_determined', 'provisional') AND app IS NOT NULL
    AND ('${platform}' = '' OR platform = '${platform}') AND ('${app}' = '' OR app = '${app}')
), latest AS (
  SELECT * FROM scoped QUALIFY ROW_NUMBER() OVER (PARTITION BY distinct_id ORDER BY ts DESC) = 1
)
SELECT platform, app, status, COUNT(*) AS users, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(ts)) AS last_report
FROM latest GROUP BY platform, app, status`;
}

function report(rows, days) {
  const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byStatus = zero();
  const platforms = { android: zero(), ios: zero(), unknown: zero() };
  const apps = { customer: zero(), partner: zero() };
  let last = null;
  for (const r of rows) {
    if (!STATUSES.includes(r.status)) continue;
    const n = Number(r.users) || 0;
    byStatus[r.status] += n;
    (platforms[r.platform] ||= zero())[r.status] += n;
    if (apps[r.app]) apps[r.app][r.status] += n;
    if (r.last_report && (!last || r.last_report > last)) last = r.last_report;
  }
  const reportingUsers = STATUSES.reduce((s, k) => s + byStatus[k], 0);
  const mutedUsers = byStatus.denied;
  return {
    days, generatedAt: new Date().toISOString(), reportingUsers, mutedUsers,
    mutedRate: reportingUsers ? Math.round((mutedUsers / reportingUsers) * 10000) / 10000 : 0,
    byStatus: STATUSES.map((status) => ({ status, users: byStatus[status] })),
    byPlatform: Object.entries(platforms).map(([platform, c]) => ({ platform, ...c })),
    byApp: Object.entries(apps).map(([app, c]) => ({ app, ...c })),
    lastReportAt: last,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await warehouseClient();
  const res = await client.native(buildSql(args), [], { scanDays: args.days });
  const out = report(res.rows, args.days);
  if (args.json) return console.log(JSON.stringify({ data: out }, null, 2));
  console.log(`Notification permission, last ${args.days} days (latest status per user)`);
  console.log(`  reporting users: ${out.reportingUsers}`);
  console.log(`  muted (denied):  ${out.mutedUsers} (${(out.mutedRate * 100).toFixed(1)}%)`);
  for (const s of out.byStatus) console.log(`  ${s.status.padEnd(15)} ${s.users}`);
  for (const p of out.byPlatform) console.log(`  platform ${p.platform.padEnd(8)} ${STATUSES.map((s) => `${s}=${p[s]}`).join(' ')}`);
  for (const a of out.byApp) console.log(`  app ${a.app.padEnd(13)} ${STATUSES.map((s) => `${s}=${a[s]}`).join(' ')}`);
  console.log(`  last report: ${out.lastReportAt || 'none yet'}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parseArgs, buildSql, report };
