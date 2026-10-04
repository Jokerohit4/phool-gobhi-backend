#!/usr/bin/env node
/* Runs first-party SQL over the analytics_events sink and prints the metrics an
 * investor will ask for: event inventory, DAU/MAU, retention by first-seen
 * cohort, the attendance funnel, and per-gym activity (the churn proxy, since
 * gyms are free to us and never "renew" anything).
 *
 * Nothing here is emitted as a new event on purpose - most of what we need is
 * already in the sink and only needs querying.
 *
 * Usage:  ANALYTICS_DATABASE_URL=<url> node scripts/investor-metrics.cjs [query]
 *         pass a query name to run just one (inventory|dau|retention|funnel|gyms)
 *
 * Exits 1 with a readable message when the table is missing, so a fresh
 * database reports "no analytics yet" instead of a stack trace.
 */
const { Pool } = require('pg');

const url = process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set ANALYTICS_DATABASE_URL (or DATABASE_URL) to the analytics database.');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });

const QUERIES = {
  // What is actually in the sink, and how far back does it go. This is the
  // query that tells you whether any number below is trustworthy.
  inventory: {
    title: 'Event inventory',
    sql: `
      SELECT event, service, source,
             count(*)                          AS rows,
             count(DISTINCT distinct_id)       AS users,
             min(ts)                           AS first_ts,
             max(ts)                           AS last_ts
      FROM analytics_events
      GROUP BY event, service, source
      ORDER BY rows DESC`,
  },

  // DAU per day for 30 days plus the DAU/MAU ratio. The single most-asked
  // question, and the one the 20k-DAU plan rests on.
  dau: {
    title: 'DAU / MAU (last 30 days)',
    sql: `
      WITH days AS (
        SELECT generate_series(current_date - 29, current_date, interval '1 day')::date AS d
      ),
      per_day AS (
        SELECT d, (
          SELECT count(DISTINCT a.distinct_id)
          FROM analytics_events a
          WHERE a.ts::date = d.d AND a.distinct_id IS NOT NULL
        ) AS dau
        FROM days d
      ),
      mau AS (
        SELECT count(DISTINCT distinct_id) AS users
        FROM analytics_events
        WHERE ts >= now() - interval '30 days' AND distinct_id IS NOT NULL
      )
      SELECT p.d AS day, p.dau, m.users AS mau_30d,
             CASE WHEN m.users = 0 THEN NULL
                  ELSE round(100.0 * p.dau / m.users, 1) END AS dau_pct_of_mau
      FROM per_day p CROSS JOIN mau m
      ORDER BY p.d`,
  },

  // Retention by the day a user was first ever seen. Offsets are calendar-day
  // based, which under-counts late-night activity across midnight; good enough
  // for a cohort shape, not for a finance number.
  retention: {
    title: 'Retention by first-seen cohort (last 60 days of cohorts)',
    sql: `
      WITH first_seen AS (
        SELECT distinct_id, min(ts)::date AS cohort_day
        FROM analytics_events
        WHERE distinct_id IS NOT NULL
        GROUP BY distinct_id
      )
      SELECT f.cohort_day,
             count(*) AS cohort_size,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM analytics_events a
               WHERE a.distinct_id = f.distinct_id AND a.ts::date = f.cohort_day + 1)) AS d1,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM analytics_events a
               WHERE a.distinct_id = f.distinct_id AND a.ts::date = f.cohort_day + 7)) AS d7,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM analytics_events a
               WHERE a.distinct_id = f.distinct_id AND a.ts::date = f.cohort_day + 30)) AS d30
      FROM first_seen f
      WHERE f.cohort_day >= current_date - 60
      GROUP BY f.cohort_day
      ORDER BY f.cohort_day`,
  },

  // The attendance-distribution funnel, built only from events already emitted.
  // "install" is proxied by any activity at all, since we have no install event.
  funnel: {
    title: 'Attendance funnel (from existing events)',
    sql: `
      SELECT
        count(DISTINCT distinct_id) FILTER (WHERE event = 'booking_created')          AS booked,
        count(DISTINCT distinct_id) FILTER (WHERE event = 'checkin_requested')        AS checkin_requested,
        count(DISTINCT distinct_id) FILTER (WHERE event = 'independent_checkin')     AS self_checkin,
        count(DISTINCT distinct_id) FILTER (WHERE event = 'trainer_checked_in')      AS trainer_checkin,
        count(DISTINCT distinct_id) FILTER (WHERE event = 'booking_completed')       AS completed,
        count(DISTINCT distinct_id) FILTER (WHERE event = 'health_consent_granted')  AS health_opted_in,
        count(DISTINCT distinct_id)                                                AS any_activity
      FROM analytics_events
      WHERE ts >= now() - interval '90 days'`,
  },

  // The gym-churn proxy. Gyms are free to us, so they never fire a renewal
  // event; a gym whose last tagged activity is old has drifted away. Also the
  // source of the "did attendance go up for the gym" number.
  gyms: {
    title: 'Per-gym activity (churn proxy)',
    sql: `
      SELECT properties->>'gym_id' AS gym_id,
             count(*)                                                          AS rows_90d,
             count(DISTINCT distinct_id)                                       AS members_90d,
             max(ts)                                                           AS last_activity,
             current_date - max(ts)::date                                      AS days_since_activity,
             count(*) FILTER (WHERE ts::date = current_date)                   AS today,
             count(*) FILTER (WHERE ts >= now() - interval '7 days')           AS last_7d
      FROM analytics_events
      WHERE properties ? 'gym_id'
        AND ts >= now() - interval '90 days'
      GROUP BY 1
      ORDER BY max(ts) DESC NULLS LAST
      LIMIT 100`,
  },
};

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace('T', ' ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function main() {
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(QUERIES);
  for (const n of names) {
    const q = QUERIES[n];
    if (!q) {
      console.error(`Unknown query "${n}". Available: ${Object.keys(QUERIES).join(', ')}`);
      process.exit(1);
    }
    let res;
    try {
      res = await pool.query(q.sql);
    } catch (err) {
      if (err.code === '42P01') {
        console.error(`\n== ${q.title} ==\nNo analytics_events table in this database yet (42P01).`);
        process.exit(1);
      }
      console.error(`\n== ${q.title} ==\nFAILED: ${err.message}`);
      process.exit(1);
    }
    console.log(`\n== ${q.title} ==`);
    if (!res.rows.length) {
      console.log('(no rows)');
      continue;
    }
    const cols = res.fields.map((f) => f.name);
    console.log(cols.join(' | '));
    console.log('-'.repeat(Math.min(120, cols.join(' | ').length + cols.length * 6)));
    for (const row of res.rows) console.log(cols.map((c) => fmt(row[c])).join(' | '));
    console.log(`(${res.rows.length} rows)`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
