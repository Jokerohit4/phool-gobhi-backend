// One bounded warehouse query for the Traffic report. Only client activity is
// counted: server jobs and operational truth events are not evidence of app use.
const PRODUCTS = ['all', 'customer', 'partner', 'website'];
const PLATFORMS = ['both', 'android', 'ios'];

export function trafficFilters(input = {}) {
  const product = input.product ?? 'all';
  const platform = input.platform ?? 'both';
  if (!PRODUCTS.includes(product) || !PLATFORMS.includes(platform)) {
    throw Object.assign(new Error('Invalid traffic product or platform'), { status: 400 });
  }
  const n = Number(input.days ?? 30);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw Object.assign(new Error('Traffic days must be an integer from 1 to 365'), { status: 400 });
  }
  return { product, platform: ['customer', 'partner'].includes(product) ? platform : 'both', days: n };
}

export function buildTrafficQuery(input = {}, { bigQuery = false, asOf = new Date(), project = 'phool-gobhi', dataset = 'analytics_dev' } = {}) {
  const filters = trafficFilters(input);
  if (!/^[a-z][a-z0-9-]+$/.test(project) || !/^analytics_(dev|prod)$/.test(dataset)) throw new Error('Invalid traffic warehouse');
  const end = new Date(asOf);
  const since = days => new Date(end.getTime() - days * 86400000).toISOString();
  const values = [since(Math.max(30, filters.days)), end.toISOString(), since(filters.days), since(1), since(7), since(30), filters.product, filters.platform];
  const parameter = i => bigQuery ? `@p${i}` : `$${i}`;
  const timestamp = i => bigQuery ? `TIMESTAMP(${parameter(i)})` : `CAST(${parameter(i)} AS timestamptz)`;
  const prop = key => bigQuery ? `JSON_VALUE(properties, '$.${key}')` : `properties->>'${key}'`;
  const date = value => bigQuery ? `FORMAT_TIMESTAMP('%Y-%m-%d', ${value}, 'Asia/Kolkata')` : `to_char(${value} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;
  const text = value => `CAST(${value} AS ${bigQuery ? 'STRING' : 'text'})`;
  const diff = (a, b) => bigQuery ? `(TIMESTAMP_DIFF(${a}, ${b}, MICROSECOND) / 1000000.0)` : `EXTRACT(EPOCH FROM (${a} - ${b}))`;
  const hour = "EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Kolkata')";
  const weekday = bigQuery ? "MOD(EXTRACT(DAYOFWEEK FROM ts AT TIME ZONE 'Asia/Kolkata') + 5, 7)" : "(EXTRACT(ISODOW FROM ts AT TIME ZONE 'Asia/Kolkata') - 1)";
  const table = bigQuery ? `\`${project}.${dataset}.events_between\`(${timestamp(1)}, ${timestamp(2)}, ARRAY<STRING>[])` : 'analytics_events';
  // Every UNION branch shares these columns, keeping the REST adapter flat.
  // n = events/frequency, users = identities, views = screen views;
  // seconds = inferred engagement, measured = sessions with an observed gap.
  const sql = `WITH raw AS (
    SELECT ts, event, distinct_id,
      CASE ${prop('app')} WHEN 'phool_gobhi' THEN 'customer' WHEN 'customer' THEN 'customer'
        WHEN 'phool_gobhi_partner' THEN 'partner' WHEN 'partner' THEN 'partner'
        WHEN 'website' THEN 'website' ELSE 'unknown' END AS app,
      LOWER(COALESCE(${prop('platform')}, 'unknown')) AS platform,
      NULLIF(${prop('session_id')}, '') AS session_id,
      NULLIF(${prop('anon_distinct_id')}, '') AS anon_id,
      CASE WHEN event = 'screen_viewed' THEN COALESCE(NULLIF(${prop('screen_name')}, ''), '(unnamed screen)') END AS screen
    FROM ${table}
    WHERE ts >= ${timestamp(1)} AND ts < ${timestamp(2)} AND source = 'client'
      AND distinct_id IS NOT NULL AND distinct_id NOT IN ('', 'anonymous')
      AND event != 'loading_wait_ended' AND event NOT LIKE 'explore_queue_%'
  ), identity_links AS (
    SELECT app, anon_id, distinct_id AS identified_id,
      ROW_NUMBER() OVER (PARTITION BY app, anon_id ORDER BY ts DESC, distinct_id) AS alias_rank
    FROM raw WHERE event = 'identify' AND anon_id IS NOT NULL AND anon_id != distinct_id
  ), scoped AS (
    SELECT r.*, CONCAT(r.app, ':', COALESCE(l.identified_id, r.distinct_id)) AS actor FROM raw r
    LEFT JOIN identity_links l ON l.app = r.app AND l.anon_id = r.distinct_id AND l.alias_rank = 1
    WHERE r.event != 'identify' AND r.app IN ('customer', 'partner', 'website')
      AND (${parameter(7)} = 'all' OR r.app = ${parameter(7)})
      AND (${parameter(7)} NOT IN ('customer', 'partner') OR
        (r.platform IN ('android', 'ios') AND (${parameter(8)} = 'both' OR r.platform = ${parameter(8)})))
  ), current_events AS (
    SELECT * FROM scoped WHERE ts >= ${timestamp(3)}
  ), previous AS (
    SELECT *, LAG(ts) OVER (PARTITION BY app, platform, session_id ORDER BY ts, event, actor) AS previous_ts
    FROM current_events WHERE session_id IS NOT NULL
  ), segmented AS (
    SELECT *, SUM(CASE WHEN previous_ts IS NULL OR ${diff('ts', 'previous_ts')} > 1800 THEN 1 ELSE 0 END)
      OVER (PARTITION BY app, platform, session_id ORDER BY ts, event, actor ROWS UNBOUNDED PRECEDING) AS visit
    FROM previous
  ), screen_groups AS (
    SELECT *, SUM(CASE WHEN screen IS NOT NULL THEN 1 ELSE 0 END)
      OVER (PARTITION BY app, platform, session_id, visit ORDER BY ts, event, actor ROWS UNBOUNDED PRECEDING) AS screen_group,
      LEAD(ts) OVER (PARTITION BY app, platform, session_id, visit ORDER BY ts, event, actor) AS next_ts
    FROM segmented
  ), intervals AS (
    SELECT *, MAX(screen) OVER (PARTITION BY app, platform, session_id, visit, screen_group) AS active_screen,
      CASE WHEN ${diff('next_ts', 'ts')} BETWEEN 0 AND 300 THEN ${diff('next_ts', 'ts')} ELSE 0 END AS seconds
    FROM screen_groups
  ), visits AS (
    SELECT app, platform, session_id, visit, SUM(seconds) AS seconds
    FROM intervals GROUP BY app, platform, session_id, visit
  ), screen_time AS (
    SELECT app, platform, active_screen AS screen, SUM(seconds) AS seconds
    FROM intervals WHERE active_screen IS NOT NULL GROUP BY app, platform, active_screen
  ), screens AS (
    SELECT app, platform, screen, COUNT(*) AS n, COUNT(DISTINCT actor) AS users
    FROM current_events WHERE event = 'screen_viewed' GROUP BY app, platform, screen
  ), product_time AS (
    SELECT app, platform, COUNT(*) AS sessions, SUM(seconds) AS seconds,
      SUM(CASE WHEN seconds > 0 THEN 1 ELSE 0 END) AS measured
    FROM visits GROUP BY app, platform
  ), frequency AS (
    SELECT actor, COUNT(DISTINCT ${date('ts')}) AS active_days FROM current_events GROUP BY actor
  ), results AS (
    SELECT 'summary' AS kind, '' AS label, '' AS app, '' AS platform,
      COUNT(*) AS n, COUNT(DISTINCT actor) AS users,
      SUM(CASE WHEN event = 'screen_viewed' THEN 1 ELSE 0 END) AS views,
      (SELECT COUNT(*) FROM visits) AS sessions,
      COALESCE((SELECT SUM(seconds) FROM visits), 0) AS seconds,
      (SELECT COUNT(*) FROM visits WHERE seconds > 0) AS measured
    FROM current_events
    UNION ALL
    SELECT 'active', 'dau', '', '', 0, COUNT(DISTINCT actor), 0, 0, 0, 0 FROM scoped WHERE ts >= ${timestamp(4)}
    UNION ALL
    SELECT 'active', 'wau', '', '', 0, COUNT(DISTINCT actor), 0, 0, 0, 0 FROM scoped WHERE ts >= ${timestamp(5)}
    UNION ALL
    SELECT 'active', 'mau', '', '', 0, COUNT(DISTINCT actor), 0, 0, 0, 0 FROM scoped WHERE ts >= ${timestamp(6)}
    UNION ALL
    SELECT 'daily', ${date('ts')}, '', '', COUNT(*), COUNT(DISTINCT actor),
      SUM(CASE WHEN event = 'screen_viewed' THEN 1 ELSE 0 END), 0, 0, 0
    FROM current_events GROUP BY ${date('ts')}
    UNION ALL
    SELECT 'screen', s.screen, s.app, s.platform, s.n, s.users, s.n, 0, COALESCE(t.seconds, 0), 0
    FROM screens s LEFT JOIN screen_time t ON s.app = t.app AND s.platform = t.platform AND s.screen = t.screen
    UNION ALL
    SELECT 'action', event, app, platform, COUNT(*), COUNT(DISTINCT actor), 0, 0, 0, 0
    FROM current_events WHERE event NOT IN ('screen_viewed', 'session_started') GROUP BY event, app, platform
    UNION ALL
    SELECT 'hour', ${text(weekday)}, '', ${text(hour)}, COUNT(*), COUNT(DISTINCT actor), 0, 0, 0, 0
    FROM current_events GROUP BY 2, 4
    UNION ALL
    SELECT 'product', '', e.app, e.platform, COUNT(*), COUNT(DISTINCT e.actor),
      SUM(CASE WHEN e.event = 'screen_viewed' THEN 1 ELSE 0 END),
      COALESCE(t.sessions, 0), COALESCE(t.seconds, 0), COALESCE(t.measured, 0)
    FROM current_events e LEFT JOIN product_time t ON e.app = t.app AND e.platform = t.platform
    GROUP BY e.app, e.platform, t.sessions, t.seconds, t.measured
    UNION ALL
    SELECT 'frequency', ${text('active_days')}, '', '', COUNT(*), COUNT(*), 0, 0, 0, 0 FROM frequency GROUP BY active_days
    UNION ALL
    SELECT 'coverage', 'session_events', '', '', COUNT(*), 0, 0, 0, 0, 0 FROM current_events WHERE session_id IS NOT NULL
    UNION ALL
    SELECT 'length', CASE WHEN seconds = 0 THEN 'No observed time' WHEN seconds < 60 THEN 'Under 1 min'
      WHEN seconds < 300 THEN '1–5 min' WHEN seconds < 900 THEN '5–15 min' ELSE '15+ min' END,
      '', '', COUNT(*), 0, 0, 0, 0, 0 FROM visits GROUP BY
      CASE WHEN seconds = 0 THEN 'No observed time' WHEN seconds < 60 THEN 'Under 1 min'
      WHEN seconds < 300 THEN '1–5 min' WHEN seconds < 900 THEN '5–15 min' ELSE '15+ min' END
  ) SELECT * FROM results`;
  const queryParameters = values.map((value, i) => ({ name: `p${i + 1}`, parameterType: { type: 'STRING' }, parameterValue: { value: String(value) } }));
  return { sql, values, queryParameters, filters, asOf: end.toISOString() };
}

export function trafficReport(rows, { filters, asOf }) {
  const numeric = ['n', 'users', 'views', 'sessions', 'seconds', 'measured'];
  const normalized = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, numeric.includes(key) ? Number(value) || 0 : value])));
  const of = kind => normalized.filter(row => row.kind === kind);
  const summary = of('summary')[0] || { n: 0, users: 0, views: 0, sessions: 0, seconds: 0, measured: 0 };
  const active = Object.fromEntries(of('active').map(row => [row.label, row.users]));
  const sessionEvents = of('coverage')[0]?.n || 0;
  return {
    filters, asOf, timezone: 'Asia/Kolkata', activeUsers: { dau: active.dau || 0, wau: active.wau || 0, mau: active.mau || 0 },
    summary: { ...summary, sessionEvents, averageSecondsPerSession: summary.sessions ? summary.seconds / summary.sessions : null,
      averageSecondsPerUser: summary.users && summary.sessions ? summary.seconds / summary.users : null },
    daily: of('daily').sort((a, b) => a.label.localeCompare(b.label)),
    screens: of('screen').sort((a, b) => b.seconds - a.seconds || b.views - a.views).slice(0, 30),
    actions: of('action').sort((a, b) => b.users - a.users || b.n - a.n).slice(0, 30),
    heatmap: of('hour'), breakdown: of('product').sort((a, b) => b.users - a.users),
    frequency: of('frequency').sort((a, b) => Number(a.label) - Number(b.label)), sessionLengths: of('length'),
  };
}
