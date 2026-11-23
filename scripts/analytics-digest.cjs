#!/usr/bin/env node
/*
 * Phool Gobhi analytics funnel digest — prints the funnels from docs/ANALYTICS.md §8
 * against the first-party `analytics_events` table (currently the shared booking Neon DB).
 *
 * Reads the connection string from (in order):
 *   1. process.env.ANALYTICS_DATABASE_URL
 *   2. scripts/.analytics.env  (a gitignored file: ANALYTICS_DATABASE_URL=postgres://...)
 *
 * The URL is a secret and must NEVER be committed or echoed. Populate the file once with:
 *   gcloud secrets versions access latest --secret=<name> --project=phool-gobhi \
 *     | sed 's/^/ANALYTICS_DATABASE_URL=/' > scripts/.analytics.env
 * (or just: echo "ANALYTICS_DATABASE_URL=<url>" > scripts/.analytics.env)
 *
 * Run:  node scripts/analytics-digest.cjs
 * Loop: /loop 30m /analytics-digest  (in Claude Code, while working)
 */
const fs = require('fs');
const path = require('path');

// pg lives in wallet-service's node_modules, not at repo root.
let pg;
try {
  pg = require('pg');
} catch {
  pg = require(path.join(__dirname, '..', 'services', 'wallet-service', 'node_modules', 'pg'));
}
const { Client } = pg;

function loadUrl() {
  if (process.env.ANALYTICS_DATABASE_URL) return process.env.ANALYTICS_DATABASE_URL.trim();
  const envFile = path.join(__dirname, '.analytics.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*ANALYTICS_DATABASE_URL\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  return null;
}

// The live booking event is booking_created (booking_confirmed is not emitted anywhere).
const FUNNEL = ['gym_viewed', 'slot_selected', 'book_tapped', 'booking_created'];

// Activation stages for APP devices/users (ios + android only). Each stage is a unique person
// (anonymous devices are folded into their user through `identify`); see analytics-identity.cjs.
const ACTIVATION_STAGES = [
  ['saw_screen', 'saw a screen (screen_viewed from ios/android)'],
  ['otp', 'requested OTP (otp_requested)'],
  ['logged_in', 'logged in / identified (identify or login_completed)'],
  ['signup', 'signup_completed'],
  ['onb', 'coach_onboarding_completed'],
  ['home', 'home_viewed (first home view)'],
  ['workout', 'workout_started (first workout)'],
  ['returned', 'returned on a later IST day (any event except identify/signup/login)'],
];

const { IDENTITY_CTES, NON_ENGAGEMENT_EVENTS, IST } = require('./analytics-identity.cjs');

async function platformFunnelRows(client) {
  const sql = `WITH ${IDENTITY_CTES}
    SELECT COALESCE(pp.plat,'unknown') AS plat, e.event, COUNT(DISTINCT e.person) AS users
    FROM ev e LEFT JOIN person_platform pp ON pp.person=e.person
    WHERE e.event IN (${FUNNEL.map((x) => `'${x}'`).join(',')}) GROUP BY 1,2`;
  return (await client.native(sql, [], { scanDays: 30 })).rows;
}

async function activationRows(client) {
  const nonEng = NON_ENGAGEMENT_EVENTS.map((x) => `'${x}'`).join(',');
  const sql = `WITH ${IDENTITY_CTES}
    SELECT pp.plat,
      LOGICAL_OR(e.event='screen_viewed' AND e.plat IN ('ios','android')) AS saw_screen,
      LOGICAL_OR(e.event='otp_requested') AS otp,
      LOGICAL_OR(e.event IN ('identify','login_completed')) AS logged_in,
      LOGICAL_OR(e.event='signup_completed') AS signup,
      LOGICAL_OR(e.event='coach_onboarding_completed') AS onb,
      LOGICAL_OR(e.event='home_viewed') AS home,
      LOGICAL_OR(e.event='workout_started') AS workout,
      IFNULL(DATE_DIFF(MAX(IF(e.event NOT IN (${nonEng}),DATE(e.ts,'${IST}'),NULL)),
                       MIN(IF(e.event NOT IN (${nonEng}),DATE(e.ts,'${IST}'),NULL)),DAY),0) > 0 AS returned
    FROM ev e JOIN person_platform pp ON pp.person=e.person
    WHERE pp.plat IN ('ios','android') GROUP BY e.person, pp.plat`;
  return (await client.native(sql, [], { scanDays: 30 })).rows;
}

async function webTrafficRow(client) {
  const sql = `WITH ${IDENTITY_CTES}
    SELECT COUNT(DISTINCT IF(plat='web',person,NULL)) AS web_people, COUNTIF(plat='web' AND event='session_started') AS web_sessions,
           COUNT(DISTINCT IF(plat IN ('ios','android'),person,NULL)) AS app_people
    FROM ev`;
  return (await client.native(sql, [], { scanDays: 30 })).rows[0];
}

async function main() {
  const warehouse = (process.env.ANALYTICS_READ_PROVIDER || 'bigquery') === 'bigquery';
  const url = warehouse ? null : loadUrl();
  if (!warehouse && !url) {
    console.error(
      'No ANALYTICS_DATABASE_URL found.\n' +
        'Create scripts/.analytics.env (gitignored) with:\n' +
        '  ANALYTICS_DATABASE_URL=postgres://...\n' +
        'e.g. pull it from Secret Manager (run this yourself so the secret stays out of chat):\n' +
        '  gcloud secrets versions access latest --secret=<name> --project=phool-gobhi ' +
        "| sed 's/^/ANALYTICS_DATABASE_URL=/' > scripts/.analytics.env"
    );
    process.exit(1);
  }

  const client = warehouse ? await require('./analytics-client.cjs').warehouseClient() : new Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    // Table may not exist yet if no events have ever been written.
    const exists = await client.query("SELECT to_regclass('public.analytics_events') AS t");
    if (!exists.rows[0].t) {
      console.log('analytics_events table does not exist yet — no events captured. (Is ANALYTICS_PROVIDER=postgres?)');
      return;
    }

    const [snap, activation, onboarding, top] = await Promise.all([
      client.query(
        `SELECT
           count(*)                                            AS total_events,
           count(*) FILTER (WHERE ts > now() - interval '24 hours') AS events_24h,
           count(DISTINCT distinct_id) FILTER (WHERE ts > now() - interval '24 hours') AS users_24h
         FROM analytics_events`
      ),
      client.query(
        `SELECT event, count(*) AS n
           FROM analytics_events
          WHERE event IN ('otp_requested','signup_completed','login_completed')
            AND ts > now() - interval '7 days'
          GROUP BY event`
      ),
      client.query(
        `SELECT properties->>'step' AS step, count(*) AS completions
           FROM analytics_events
          WHERE event = 'onboarding_step_completed'
          GROUP BY 1 ORDER BY 1`
      ),
      client.query(
        `SELECT event, count(*) AS n
           FROM analytics_events
          WHERE ts > now() - interval '24 hours'
          GROUP BY event ORDER BY n DESC LIMIT 8`
      ),
    ]);

    const s = snap.rows[0];
    const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—');

    console.log('════════ Phool Gobhi — Analytics Digest ════════');
    console.log(`Total events: ${s.total_events}   |   last 24h: ${s.events_24h} events, ${s.users_24h} users`);

    if (!warehouse) {
      console.log('\n(platform split + app activation sections need the BigQuery warehouse read path)');
    } else {
      const [fun, act, traffic] = await Promise.all([platformFunnelRows(client), activationRows(client), webTrafficRow(client)]);
      console.log(`\n── Traffic mix (30d, unique people) ──\n  web: ${traffic.web_people} (${traffic.web_sessions} sessions)   app (ios+android): ${traffic.app_people}`);
      console.log('  NOTE: web traffic is mostly anonymous marketing-site visitors; never read it as app usage.');

      console.log('\n── Booking funnel by platform (unique people, 30d) ──');
      console.log('  Definition: gym_viewed -> slot_selected -> book_tapped -> booking_created (server event, attributed');
      console.log('  through the person\'s first client-reported platform; app = ios+android, unknown = no client event).');
      const groups = { app: ['ios', 'android'], ios: ['ios'], android: ['android'], web: ['web'], unknown: ['unknown'] };
      const cnt = (plats, ev) => fun.filter((r) => plats.includes(r.plat) && r.event === ev).reduce((n, r) => n + Number(r.users), 0);
      console.log('  ' + 'event'.padEnd(18) + Object.keys(groups).map((g) => g.padStart(9)).join(''));
      for (const step of FUNNEL) console.log('  ' + step.padEnd(18) + Object.values(groups).map((p) => String(cnt(p, step)).padStart(9)).join(''));

      console.log('\n── App activation funnel (ios+android only, unique people, 30d) ──');
      console.log('  "reached" = did the action at least once; "funnel" = reached every stage up to and including this one.');
      console.log('  ' + 'stage'.padEnd(11) + ['app', 'ios', 'android'].map((g) => (g + ' reached').padStart(16) + (g + ' funnel').padStart(15)).join(''));
      const sets = { app: act, ios: act.filter((r) => r.plat === 'ios'), android: act.filter((r) => r.plat === 'android') };
      const nest = (rows, idx) => rows.filter((r) => ACTIVATION_STAGES.slice(0, idx + 1).every(([k]) => r[k])).length;
      ACTIVATION_STAGES.forEach(([key], idx) => {
        console.log('  ' + key.padEnd(11) + Object.values(sets).map((rows) => String(rows.filter((r) => r[key]).length).padStart(16) + String(nest(rows, idx)).padStart(15)).join(''));
      });
      console.log('  Stage definitions:');
      for (const [key, def] of ACTIVATION_STAGES) console.log(`    ${key}: ${def}`);
    }

    console.log('\n── Auth events (7d, all platforms) ──');
    if (activation.rows.length === 0) console.log('  (none)');
    for (const r of activation.rows) console.log(`  ${r.event.padEnd(18)} ${String(r.n).padStart(6)}`);

    console.log('\n── Partner onboarding completions by step ──');
    if (onboarding.rows.length === 0) console.log('  (none)');
    for (const r of onboarding.rows) console.log(`  step ${String(r.step ?? '?').padEnd(13)} ${String(r.completions).padStart(6)}`);

    console.log('\n── Top events (last 24h) ──');
    if (top.rows.length === 0) console.log('  (none)');
    for (const r of top.rows) console.log(`  ${r.event.padEnd(24)} ${String(r.n).padStart(6)}`);
    console.log('════════════════════════════════════════════════');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Digest failed:', e.message);
  process.exit(1);
});
