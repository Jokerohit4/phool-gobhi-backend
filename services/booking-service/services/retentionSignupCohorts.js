// Retention by SIGNUP cohort (admin analytics, warehouse only).
//
// Port of scripts/retention-by-signup-day.cjs (+ scripts/analytics-identity.cjs);
// keep the two in step when the definitions change.
//
// Cohort: people whose `signup_completed` falls on an IST calendar day in
// [since, until]. Buckets are IST days or Monday-start IST weeks.
//
//  - Person: the user id; anonymous devices are folded in through `identify`.
//  - Platform: the `platform` property stamped on signup_completed itself (new
//    users) when present, else the person's first client-reported platform
//    (older users; ios/android preferred over web). app = ios + android.
//    People with neither are "unknown", counted only under platform=all.
//  - Returned on day N: any engagement event (everything except identify,
//    signup_completed, login_completed) on IST signup day + N. A person only
//    counts toward DN once day N has completely passed (signup day + N < today).
//  - Onboarded: coach_onboarding_completed / onboarding_completed after signup.
//  - Workout within 24h: workout_started within 24h of signup_completed.
//  - Active minutes day 1: for people who onboarded on their signup day, minutes
//    between onboarding and their last event that day, summing only gaps <= 5 min.
//
// The query returns one small row per person; bucketing, eligibility and medians
// are done in JS (pure, unit-tested). Reads are capped by queryBigQuery
// (ANALYTICS_MAX_BYTES_BILLED, one-minute result cache).
import { queryBigQuery } from '../utils/bigQueryAnalytics.js';
import { resolveCohortScope } from '../utils/cohortScope.js';

export const PLATFORM_FILTERS = ['app', 'ios', 'android', 'web', 'all'];
export const GRANULARITIES = ['day', 'week'];
const MAX_WINDOW_DAYS = 180;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IST_MS = 330 * 60000;

function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export const istDay = (date = new Date()) => new Date(date.getTime() + IST_MS).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const validDay = (s) => DAY_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && addDays(s, 0) === s;

/** Validates and defaults the query string. */
export function retentionSignupFilters(input = {}, now = new Date()) {
  const today = istDay(now);
  const since = input.since == null || input.since === '' ? addDays(today, -30) : String(input.since);
  const until = input.until == null || input.until === '' ? today : String(input.until);
  const platform = input.platform == null || input.platform === '' ? 'app' : String(input.platform).toLowerCase();
  const granularity = input.granularity == null || input.granularity === '' ? 'week' : String(input.granularity).toLowerCase();
  if (!validDay(since)) throw fail('since must be a YYYY-MM-DD date');
  if (!validDay(until)) throw fail('until must be a YYYY-MM-DD date');
  if (until < since) throw fail('until must not be before since');
  if (since > today) throw fail('since must not be in the future');
  if (addDays(today, -MAX_WINDOW_DAYS) > since) throw fail(`since must be within the last ${MAX_WINDOW_DAYS} days`);
  if (!PLATFORM_FILTERS.includes(platform)) throw fail(`platform must be one of ${PLATFORM_FILTERS.join(', ')}`);
  if (!GRANULARITIES.includes(granularity)) throw fail(`granularity must be one of ${GRANULARITIES.join(', ')}`);
  return { since, until, platform, granularity, today };
}

const NON_ENGAGEMENT = ["'identify'", "'signup_completed'", "'login_completed'"].join(',');
const IST = 'Asia/Kolkata';

/**
 * Parameters (all STRING, like the traffic report): p1 scan_since, p2 as_of,
 * p3 since day, p4 until day (inclusive), p5 (optional) cohort id array.
 */
export function buildRetentionSignupQuery(filters, { scope = null, project = process.env.ANALYTICS_BIGQUERY_PROJECT || 'phool-gobhi', dataset, asOf = new Date() } = {}) {
  const ds = dataset || `analytics_${process.env.ANALYTICS_ENVIRONMENT || process.env.K_SERVICE?.match(/-(dev|prod)$/)?.[1] || 'dev'}`;
  if (!/^[a-z][a-z0-9-]+$/.test(project) || !/^analytics_(dev|prod)$/.test(ds)) throw new Error('Invalid retention warehouse');
  // One day before `since` so an identify that precedes the signup day is seen.
  const scanSince = new Date(Date.parse(addDays(filters.since, -1) + 'T00:00:00Z')).toISOString();
  const values = [scanSince, new Date(asOf).toISOString(), filters.since, filters.until];
  const cohortScoped = !!scope && scope.mode !== 'all';
  if (cohortScoped) values.push(scope.ids);
  const cohortCondition = !cohortScoped ? '' : scope.mode === 'include'
    ? ' AND e.person IN UNNEST(@p5)' : ' AND e.person NOT IN UNNEST(@p5)';
  const table = `\`${project}.${ds}.events_between\`(TIMESTAMP(@p1), TIMESTAMP(@p2), ARRAY<STRING>[])`;
  const sql = `WITH raw AS (
  SELECT event, distinct_id, ts,
         JSON_VALUE(properties,'$.platform') AS plat,
         JSON_VALUE(properties,'$.anon_distinct_id') AS anon
  FROM ${table} WHERE distinct_id IS NOT NULL
),
idmap AS (
  SELECT anon, MIN(distinct_id) AS uid FROM raw WHERE event='identify' AND anon IS NOT NULL GROUP BY anon
),
ev AS (
  SELECT r.event, r.ts, COALESCE(m.uid, r.distinct_id) AS person, r.plat
  FROM raw r LEFT JOIN idmap m ON r.distinct_id = m.anon
),
person_platform AS (
  SELECT person,
         ARRAY_AGG(plat IGNORE NULLS ORDER BY IF(plat IN ('ios','android'),0,1), ts LIMIT 1)[SAFE_OFFSET(0)] AS plat
  FROM ev WHERE plat IN ('ios','android','web') GROUP BY person
),
signup_platform AS (
  SELECT person, ARRAY_AGG(plat IGNORE NULLS ORDER BY ts LIMIT 1)[SAFE_OFFSET(0)] AS plat
  FROM ev WHERE event='signup_completed' AND plat IN ('ios','android','web') GROUP BY person
),
coh AS (
  SELECT e.person AS uid, MIN(e.ts) AS signup_ts, DATE(MIN(e.ts),'${IST}') AS signup_day
  FROM ev e WHERE e.event='signup_completed'${cohortCondition}
  GROUP BY e.person
  HAVING DATE(MIN(e.ts),'${IST}') BETWEEN CAST(@p3 AS DATE) AND CAST(@p4 AS DATE)
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
  FROM coh c JOIN ev e ON e.person=c.uid AND e.event NOT IN (${NON_ENGAGEMENT})
  GROUP BY c.uid
),
gaps AS (
  SELECT e.person AS uid, TIMESTAMP_DIFF(e.ts, LAG(e.ts) OVER (PARTITION BY e.person ORDER BY e.ts), SECOND) AS gap
  FROM ev e JOIN coh c ON c.uid=e.person JOIN onb o ON o.uid=e.person
  WHERE e.ts >= o.onb_ts AND DATE(e.ts,'${IST}') = c.signup_day AND DATE(o.onb_ts,'${IST}') = c.signup_day
),
act AS (SELECT uid, SUM(IF(gap<=300,gap,0))/60.0 AS mins FROM gaps GROUP BY uid)
SELECT FORMAT_DATE('%F', c.signup_day) AS signup_day,
  COALESCE(sp.plat, pp.plat) AS plat,
  o.onb_ts IS NOT NULL AS onboarded, w.wk_ts IS NOT NULL AS workout_24h,
  IFNULL(r.d1,FALSE) AS d1, IFNULL(r.d3,FALSE) AS d3, IFNULL(r.d7,FALSE) AS d7, IFNULL(r.any_later,FALSE) AS any_later,
  a.mins AS active_min_day1
FROM coh c LEFT JOIN signup_platform sp ON sp.person=c.uid LEFT JOIN person_platform pp ON pp.person=c.uid
LEFT JOIN onb o ON o.uid=c.uid LEFT JOIN wk w ON w.uid=c.uid LEFT JOIN ret r ON r.uid=c.uid LEFT JOIN act a ON a.uid=c.uid
ORDER BY c.signup_day`;
  const queryParameters = values.map((value, i) => Array.isArray(value)
    ? { name: `p${i + 1}`, parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: value.map((v) => ({ value: String(v) })) } }
    : { name: `p${i + 1}`, parameterType: { type: 'STRING' }, parameterValue: { value: String(value) } });
  return { sql, values, queryParameters };
}

const bool = (v) => v === true || v === 'true';

/** Monday-start week containing an IST day. */
export function weekStart(day) {
  const dow = new Date(Date.parse(day + 'T00:00:00Z')).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

function summarize(users, today) {
  const retention = (n) => {
    const eligible = users.filter((u) => addDays(u.signup_day, n) < today);
    return { returned: eligible.filter((u) => u[`d${n}`]).length, eligible: eligible.length };
  };
  const mins = users.filter((u) => u.active_min_day1 != null && u.active_min_day1 !== '').map((u) => Number(u.active_min_day1)).filter(Number.isFinite);
  const med = median(mins);
  const onboarded = users.filter((u) => u.onboarded).length;
  const workout = users.filter((u) => u.workout_24h).length;
  return {
    size: users.length,
    d1: retention(1), d3: retention(3), d7: retention(7),
    // Any engagement on a day after signup day; eligible once signup day < today.
    anyLater: (() => { const e = users.filter((u) => u.signup_day < today); return { returned: e.filter((u) => u.any_later).length, eligible: e.length }; })(),
    onboarded, onboardedPct: pct(onboarded, users.length),
    workoutWithin24h: workout, workoutWithin24hPct: pct(workout, users.length),
    medianActiveMinutesDay1: med == null ? null : Math.round(med * 10) / 10,
    activeMinutesSample: mins.length,
  };
}

/** Pure: per-person warehouse rows -> the response body. */
export function aggregateRetentionSignupCohorts(rawRows, filters, now = new Date()) {
  const { since, until, platform, granularity, today } = filters;
  const rows = rawRows.map((r) => ({
    signup_day: String(r.signup_day),
    plat: r.plat || null,
    onboarded: bool(r.onboarded), workout_24h: bool(r.workout_24h),
    d1: bool(r.d1), d3: bool(r.d3), d7: bool(r.d7), any_later: bool(r.any_later),
    active_min_day1: r.active_min_day1 == null ? null : r.active_min_day1,
  })).filter((r) => r.signup_day >= since && r.signup_day <= until);
  const keep = (u) => platform === 'all' ? true
    : platform === 'app' ? u.plat === 'ios' || u.plat === 'android'
    : u.plat === platform;
  const users = rows.filter(keep);
  const buckets = new Map();
  for (const u of users) {
    const start = granularity === 'week' ? weekStart(u.signup_day) : u.signup_day;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(u);
  }
  const cohorts = [...buckets.keys()].sort().map((start) => ({ start, ...summarize(buckets.get(start), today) }));
  return {
    since, until, platform, granularity,
    generatedAt: now.toISOString(),
    cohorts,
    total: summarize(users, today),
  };
}

export async function getRetentionSignupCohorts(input = {}, { now = new Date(), run = queryBigQuery } = {}) {
  const filters = retentionSignupFilters(input, now);
  const scope = await resolveCohortScope(input.cohort);
  const query = buildRetentionSignupQuery(filters, { scope, asOf: now });
  const result = await run(query.sql, [], { native: true, queryParameters: query.queryParameters });
  return aggregateRetentionSignupCohorts(result.rows || [], filters, now);
}
