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

const FUNNEL = ['gym_viewed', 'slot_selected', 'book_tapped', 'booking_confirmed'];

async function main() {
  const url = loadUrl();
  if (!url) {
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

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // Table may not exist yet if no events have ever been written.
    const exists = await client.query("SELECT to_regclass('public.analytics_events') AS t");
    if (!exists.rows[0].t) {
      console.log('analytics_events table does not exist yet — no events captured. (Is ANALYTICS_PROVIDER=postgres?)');
      return;
    }

    const [snap, funnel, activation, onboarding, top] = await Promise.all([
      client.query(
        `SELECT
           count(*)                                            AS total_events,
           count(*) FILTER (WHERE ts > now() - interval '24 hours') AS events_24h,
           count(DISTINCT distinct_id) FILTER (WHERE ts > now() - interval '24 hours') AS users_24h
         FROM analytics_events`
      ),
      client.query(
        `SELECT event, count(DISTINCT distinct_id) AS users
           FROM analytics_events
          WHERE event = ANY($1) AND ts > now() - interval '30 days'
          GROUP BY event`,
        [FUNNEL]
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
    const fmap = Object.fromEntries(funnel.rows.map((r) => [r.event, Number(r.users)]));

    console.log('════════ Phool Gobhi — Analytics Digest ════════');
    console.log(`Total events: ${s.total_events}   |   last 24h: ${s.events_24h} events, ${s.users_24h} users`);

    console.log('\n── Booking funnel (unique users, 30d) ──');
    let prev = null;
    for (const step of FUNNEL) {
      const n = fmap[step] || 0;
      const fromPrev = prev === null ? '' : `  (${pct(n, prev)} of prev)`;
      const fromTop = prev === null ? '' : `  [${pct(n, fmap[FUNNEL[0]] || 0)} of top]`;
      console.log(`  ${step.padEnd(18)} ${String(n).padStart(6)}${fromPrev}${fromTop}`);
      prev = n;
    }

    console.log('\n── Activation (7d) ──');
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
