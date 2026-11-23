#!/usr/bin/env node
/*
 * Retention by signup day (warehouse, read-only).
 *
 *   ANALYTICS_ENVIRONMENT=prod node scripts/retention-by-signup-day.cjs [--since YYYY-MM-DD]
 *        [--until YYYY-MM-DD (inclusive, optional)] [--platform app|web|ios|android|all] [--json]
 *
 * Cohort: users whose `signup_completed` falls on an IST calendar day >= --since
 * (default: 30 days ago). Platform = first client-reported properties.platform of that
 * person (anonymous devices are folded into their user through `identify`); app = ios+android.
 * Users with no client event at all are "unknown": counted only with --platform all.
 *
 * Definitions (all days are IST calendar days):
 *  - Returned on day N: any event on signup day + N, excluding identify / signup_completed /
 *    login_completed. Events on the signup day never count. A user only counts toward
 *    DN if day N has completely passed (signup day + N < today IST).
 *  - "any later": any qualifying event on a day after the signup day (denominator: signup day < today).
 *  - Onboarded: coach_onboarding_completed or onboarding_completed at any time since signup.
 *  - Workout <=24h: workout_started within 24h of signup_completed.
 *  - Active min day 1: for users who onboarded on the signup day, minutes between onboarding
 *    and the last event that day, summing only gaps <= 5 min (idle time is not counted); median.
 */
const { warehouseClient } = require('./analytics-client.cjs');
const { IDENTITY_CTES, NON_ENGAGEMENT_EVENTS, IST, groupOf } = require('./analytics-identity.cjs');

function parseArgs(argv) {
  const out = { since: null, platform: 'all', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else throw Error(`Unknown argument: ${a}`);
  }
  if (!['app', 'web', 'ios', 'android', 'all'].includes(out.platform)) throw Error('--platform must be app|web|ios|android|all');
  if (out.since && !/^\d{4}-\d{2}-\d{2}$/.test(out.since)) throw Error('--since must be YYYY-MM-DD');
  return out;
}

function istToday() {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}
function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

function buildSql(sinceDay) {
  const nonEng = NON_ENGAGEMENT_EVENTS.map((e) => `'${e}'`).join(',');
  return `
WITH ${IDENTITY_CTES},
coh AS (
  SELECT e.person AS uid, MIN(e.ts) AS signup_ts, DATE(MIN(e.ts),'${IST}') AS signup_day
  FROM ev e WHERE e.event='signup_completed' GROUP BY e.person
  HAVING DATE(MIN(e.ts),'${IST}') >= DATE '${sinceDay}'
),
onb AS (
  SELECT e.person AS uid, MIN(e.ts) AS onb_ts FROM ev e JOIN coh c ON c.uid=e.person
  WHERE e.event IN ('coach_onboarding_completed','onboarding_completed') AND e.ts >= c.signup_ts GROUP BY e.person
),
wk AS (
  SELECT e.person AS uid, MIN(e.ts) AS wk_ts FROM ev e JOIN coh c ON c.uid=e.person
  WHERE e.event='workout_started' AND e.ts >= c.signup_ts AND e.ts < TIMESTAMP_ADD(c.signup_ts, INTERVAL 24 HOUR) GROUP BY e.person
),
ret AS (
  SELECT c.uid,
    LOGICAL_OR(DATE_DIFF(DATE(e.ts,'${IST}'),c.signup_day,DAY)=1) AS d1,
    LOGICAL_OR(DATE_DIFF(DATE(e.ts,'${IST}'),c.signup_day,DAY)=3) AS d3,
    LOGICAL_OR(DATE_DIFF(DATE(e.ts,'${IST}'),c.signup_day,DAY)=7) AS d7,
    LOGICAL_OR(DATE_DIFF(DATE(e.ts,'${IST}'),c.signup_day,DAY)>=1) AS any_later
  FROM coh c JOIN ev e ON e.person=c.uid AND e.event NOT IN (${nonEng})
  GROUP BY c.uid
),
gaps AS (
  SELECT e.person AS uid, TIMESTAMP_DIFF(e.ts, LAG(e.ts) OVER (PARTITION BY e.person ORDER BY e.ts), SECOND) AS gap
  FROM ev e JOIN coh c ON c.uid=e.person JOIN onb o ON o.uid=e.person
  WHERE e.ts >= o.onb_ts AND DATE(e.ts,'${IST}') = c.signup_day AND DATE(o.onb_ts,'${IST}') = c.signup_day
),
act AS (SELECT uid, SUM(IF(gap<=300,gap,0))/60.0 AS mins FROM gaps GROUP BY uid)
SELECT FORMAT_DATE('%F', c.signup_day) AS signup_day, pp.plat,
  o.onb_ts IS NOT NULL AS onboarded, w.wk_ts IS NOT NULL AS workout_24h,
  IFNULL(r.d1,FALSE) AS d1, IFNULL(r.d3,FALSE) AS d3, IFNULL(r.d7,FALSE) AS d7, IFNULL(r.any_later,FALSE) AS any_later,
  a.mins AS active_min_day1
FROM coh c LEFT JOIN person_platform pp ON pp.person=c.uid LEFT JOIN onb o ON o.uid=c.uid
LEFT JOIN wk w ON w.uid=c.uid LEFT JOIN ret r ON r.uid=c.uid LEFT JOIN act a ON a.uid=c.uid
ORDER BY c.signup_day`;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(users, today) {
  const rate = (n) => {
    const eligible = users.filter((u) => addDays(u.signup_day, n) < today);
    return { n: eligible.filter((u) => u[`d${n}`]).length, of: eligible.length };
  };
  const eligAny = users.filter((u) => u.signup_day < today);
  const mins = users.filter((u) => u.active_min_day1 != null).map((u) => Number(u.active_min_day1));
  return {
    cohort: users.length,
    d1: rate(1), d3: rate(3), d7: rate(7),
    any_later: { n: eligAny.filter((u) => u.any_later).length, of: eligAny.length },
    onboarded: users.filter((u) => u.onboarded).length,
    workout_24h: users.filter((u) => u.workout_24h).length,
    median_active_min_day1: median(mins) == null ? null : Math.round(median(mins) * 10) / 10,
    active_min_sample: mins.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = istToday();
  const since = args.since || addDays(today, -30);
  // scan from one day before the window so identify events that precede the signup are seen
  const scanDays = Math.ceil((Date.now() - Date.parse(addDays(since, -1) + 'T00:00:00Z')) / 86400000) + 1;
  const client = await warehouseClient();
  const res = await client.native(buildSql(since), [], { scanDays });
  const rows = (res.rows || []).filter((r) => !args.until || r.signup_day <= args.until);

  const pick = (u) => {
    if (args.platform === 'all') return true;
    if (args.platform === 'app') return u.plat === 'ios' || u.plat === 'android';
    return u.plat === args.platform;
  };
  const users = rows.filter(pick);
  const byDay = {};
  for (const u of users) (byDay[u.signup_day] ||= []).push(u);
  const days = Object.keys(byDay).sort().map((d) => ({ day: d, ...summarize(byDay[d], today) }));
  const total = summarize(users, today);

  const byPlatform = {};
  for (const u of rows) (byPlatform[u.plat || 'unknown'] ||= []).push(u);
  const platforms = Object.fromEntries(Object.entries(byPlatform).map(([p, us]) => [p, summarize(us, today)]));

  const report = { environment: process.env.ANALYTICS_ENVIRONMENT, since, platform: args.platform, today_ist: today, total, days, by_platform: platforms };
  if (args.json) return console.log(JSON.stringify(report, null, 2));

  const frac = (x) => (x.of ? `${x.n}/${x.of} ${Math.round((100 * x.n) / x.of)}%` : '-');
  const pc = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  const line = (label, s) =>
    `${label.padEnd(11)}${String(s.cohort).padStart(4)}  ${frac(s.d1).padEnd(11)}${frac(s.d3).padEnd(11)}${frac(s.d7).padEnd(11)}${frac(s.any_later).padEnd(11)}${pc(s.onboarded, s.cohort).padStart(5)}${pc(s.workout_24h, s.cohort).padStart(6)}  ${s.median_active_min_day1 == null ? '-' : s.median_active_min_day1}`;
  console.log(`Retention by signup day  env=${report.environment}  since=${since}  platform=${args.platform}  (IST days, today=${today})`);
  console.log('signup day cohort D1         D3         D7         any later  onb%  wk24h  med active min d1');
  for (const d of days) console.log(line(d.day, d));
  console.log(line('TOTAL', total));
  console.log('\nBy platform (all platforms, same window):');
  for (const [p, s] of Object.entries(platforms)) console.log(line(p, s));
  console.log('\nD/any-later rates count only users whose day N is complete. unknown = no client event seen.');
}

main().catch((e) => {
  console.error('retention-by-signup-day failed:', e.message);
  process.exit(1);
});
