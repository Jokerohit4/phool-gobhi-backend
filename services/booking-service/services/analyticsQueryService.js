import pg from 'pg';
import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const { Pool } = pg;

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Deliberately a SECOND, separate pool from this service's own Prisma-backed
// operational DB (see db.js / prisma/schema.prisma) — reads here hit
// ANALYTICS_DATABASE_URL, the analytics_events store, not booking-service's
// transactional tables. Mirrors utils/analytics.js's write-side pool. When
// ANALYTICS_DATABASE_URL later points at its own dedicated Neon DB (see
// docs/ANALYTICS.md §6), only the connection string changes — nothing here.
let _pool = null;

function getPool() {
  if (_pool) return _pool;
  const url = process.env.ANALYTICS_DATABASE_URL;
  if (!url) return null;
  _pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  return _pool;
}

async function query(sql, params = []) {
  const pool = getPool();
  if (!pool) return { rows: [] };
  return pool.query(sql, params);
}

function daysParam(days) {
  const n = Number(days);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : 30;
}

// ---- Supply / partner onboarding funnel + approval SLA --------------------

const ONBOARDING_STEPS = ['onboarding_started', 'onboarding_step_completed', 'gym_created', 'gym_approved', 'gym_rejected'];

export async function getOnboardingFunnel(days) {
  const n = daysParam(days);
  const { rows: stepCounts } = await query(
    `SELECT event, count(DISTINCT distinct_id)::int AS users
       FROM analytics_events
      WHERE event = ANY($1) AND ts > now() - ($2 || ' days')::interval
      GROUP BY event`,
    [ONBOARDING_STEPS, n]
  );
  const { rows: byStep } = await query(
    `SELECT properties->>'step' AS step, count(*)::int AS completions
       FROM analytics_events
      WHERE event = 'onboarding_step_completed' AND ts > now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [n]
  );
  // Weekly run-rate on gym_approved, trailing 4 weeks — the one legitimate
  // "prediction" at this data volume: a plain trailing average projected
  // forward, not a model. See docs/ANALYTICS.md §5 funnel 6.
  const { rows: weekly } = await query(
    `SELECT date_trunc('week', ts) AS week, count(*)::int AS approvals
       FROM analytics_events
      WHERE event = 'gym_approved' AND ts > now() - interval '28 days'
      GROUP BY 1 ORDER BY 1`
  );
  const avgPerWeek = weekly.length ? weekly.reduce((s, r) => s + r.approvals, 0) / weekly.length : 0;

  return { stepCounts, byStep, weeklyApprovals: weekly, runRatePerWeek: Math.round(avgPerWeek * 10) / 10 };
}

export async function getApprovalSla(days) {
  const n = daysParam(days);
  // Self-join gym_created -> first gym_approved/gym_rejected for the same
  // gym_id — no schema change needed, both events carry gym_id + ts.
  const { rows } = await query(
    `WITH created AS (
       SELECT properties->>'gym_id' AS gym_id, min(ts) AS created_ts
         FROM analytics_events
        WHERE event = 'gym_created' AND ts > now() - ($1 || ' days')::interval
        GROUP BY 1
     ),
     resolved AS (
       SELECT properties->>'gym_id' AS gym_id, min(ts) AS resolved_ts, min(event) AS outcome
         FROM analytics_events
        WHERE event IN ('gym_approved', 'gym_rejected')
        GROUP BY 1
     )
     SELECT c.gym_id, c.created_ts, r.resolved_ts, r.outcome,
            EXTRACT(EPOCH FROM (r.resolved_ts - c.created_ts)) / 3600.0 AS hours_to_resolve
       FROM created c
       LEFT JOIN resolved r ON r.gym_id = c.gym_id
      ORDER BY c.created_ts DESC`,
    [n]
  );
  const resolvedHours = rows.filter((r) => r.hours_to_resolve != null).map((r) => Number(r.hours_to_resolve));
  const medianHours = resolvedHours.length
    ? resolvedHours.sort((a, b) => a - b)[Math.floor(resolvedHours.length / 2)]
    : null;
  return { gyms: rows, medianHoursToResolve: medianHours != null ? Math.round(medianHours * 10) / 10 : null };
}

// ---- Booking conversion / GMV funnel ---------------------------------------

const CONVERSION_STEPS = ['gym_viewed', 'slot_selected', 'book_tapped', 'booking_confirmed'];

export async function getConversionFunnel(days) {
  const n = daysParam(days);
  const { rows: steps } = await query(
    `SELECT event, count(DISTINCT distinct_id)::int AS users
       FROM analytics_events
      WHERE event = ANY($1) AND ts > now() - ($2 || ' days')::interval
      GROUP BY event`,
    [CONVERSION_STEPS, n]
  );
  const { rows: failuresByReason } = await query(
    `SELECT properties->>'reason' AS reason, count(*)::int AS n
       FROM analytics_events
      WHERE event = 'booking_failed' AND ts > now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY n DESC`,
    [n]
  );
  return { steps, failuresByReason };
}

// ---- Gym-scoped discovery funnel (partner-facing) ---------------------------

// The per-gym equivalent of getConversionFunnel, for the partner-facing
// "Gym insights" view (attendance-SaaS gap-analysis item: "analytics never
// reach the partner"). slot_selected is deliberately excluded — the client
// never attaches gym_id to that event (see book_gym_cubit.dart), so it can't
// be scoped per gym without a client change; the three that DO carry gym_id
// (gym_viewed, book_tapped, booking_confirmed) still tell the partner where
// their own funnel leaks.
const GYM_FUNNEL_STEPS = ['gym_viewed', 'book_tapped', 'booking_confirmed'];

export async function getGymFunnel(gymId, days) {
  const n = daysParam(days);
  const { rows: steps } = await query(
    `SELECT event, count(DISTINCT distinct_id)::int AS users
       FROM analytics_events
      WHERE event = ANY($1) AND properties->>'gym_id' = $2
        AND ts > now() - ($3 || ' days')::interval
      GROUP BY event`,
    [GYM_FUNNEL_STEPS, String(gymId), n]
  );
  return { steps };
}

// ---- Fulfillment / attendance funnel ---------------------------------------

export async function getFulfillmentFunnel(days) {
  const n = daysParam(days);
  const { rows: steps } = await query(
    `SELECT event, count(DISTINCT distinct_id)::int AS users
       FROM analytics_events
      WHERE event IN ('booking_confirmed', 'checkin_requested', 'attendance_verified', 'booking_completed')
        AND ts > now() - ($1 || ' days')::interval
      GROUP BY event`,
    [n]
  );
  const { rows: byMethod } = await query(
    `SELECT properties->>'method' AS method, count(*)::int AS n
       FROM analytics_events
      WHERE event = 'attendance_verified' AND ts > now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY n DESC`,
    [n]
  );
  return { steps, byMethod };
}

// ---- Activation -------------------------------------------------------------

export async function getActivation(days) {
  const n = daysParam(days);
  const { rows } = await query(
    `SELECT event, count(*)::int AS n, count(DISTINCT distinct_id)::int AS distinct_users
       FROM analytics_events
      WHERE event IN ('otp_requested', 'otp_submitted', 'signup_completed', 'login_completed')
        AND ts > now() - ($1 || ' days')::interval
      GROUP BY event`,
    [n]
  );
  return { steps: rows };
}

// ---- Wallet top-up funnel ---------------------------------------------------

export async function getWalletFunnel(days) {
  const n = daysParam(days);
  const { rows } = await query(
    `SELECT event, count(DISTINCT distinct_id)::int AS users
       FROM analytics_events
      WHERE event IN ('topup_tapped', 'wallet_topup_order_created', 'wallet_topup_succeeded', 'wallet_topup_failed')
        AND ts > now() - ($1 || ' days')::interval
      GROUP BY event`,
    [n]
  );
  return { steps: rows };
}

// ---- Buddy engagement funnel -------------------------------------------------

export async function getBuddyFunnel(days) {
  const n = daysParam(days);
  const { rows } = await query(
    `SELECT event, count(DISTINCT distinct_id)::int AS users
       FROM analytics_events
      WHERE event IN ('buddy_profile_created', 'buddy_swiped', 'buddy_matched', 'buddy_message_sent',
                       'buddy_unmatched', 'buddy_blocked')
        AND ts > now() - ($1 || ' days')::interval
      GROUP BY event`,
    [n]
  );
  return { steps: rows };
}

// ---- City breakdown -----------------------------------------------------------

// Bookings/GMV and gym counts by city — the `city` property was denormalized
// onto booking events (and was already native on gym events) specifically so
// this kind of slice needs no join back to the gym table.
export async function getCityBreakdown(days) {
  const n = daysParam(days);
  const { rows: bookingRows } = await query(
    `SELECT COALESCE(properties->>'city', 'Unknown') AS city,
            count(*)::int AS bookings,
            COALESCE(sum((properties->>'amount')::numeric), 0)::float AS gmv
       FROM analytics_events
      WHERE event = 'booking_confirmed' AND ts > now() - ($1 || ' days')::interval
      GROUP BY 1`,
    [n]
  );
  const { rows: gymRows } = await query(
    `SELECT COALESCE(properties->>'city', 'Unknown') AS city,
            count(*) FILTER (WHERE event = 'gym_created')::int AS gyms_created,
            count(*) FILTER (WHERE event = 'gym_approved')::int AS gyms_approved
       FROM analytics_events
      WHERE event IN ('gym_created', 'gym_approved') AND ts > now() - ($1 || ' days')::interval
      GROUP BY 1`,
    [n]
  );
  const byCity = new Map();
  for (const r of gymRows) {
    byCity.set(r.city, { city: r.city, gymsCreated: r.gyms_created, gymsApproved: r.gyms_approved, bookings: 0, gmv: 0 });
  }
  for (const r of bookingRows) {
    const existing = byCity.get(r.city) || { city: r.city, gymsCreated: 0, gymsApproved: 0, bookings: 0, gmv: 0 };
    existing.bookings = r.bookings;
    existing.gmv = r.gmv;
    byCity.set(r.city, existing);
  }
  return { cities: [...byCity.values()].sort((a, b) => b.gmv - a.gmv) };
}

// ---- Gamification wave 1: badge summary --------------------------------------

// Per-gym badge_earned counts, ascending (lowest first) — a low count here
// means few customers are having their "first visit" at that gym, i.e. a
// supply-density signal for gyms that aren't getting explored. This can't
// surface gyms with a literal zero count (analytics_events only has rows for
// events that fired; the full gym list lives in gym-service's own DB, not
// this analytics pool) — that join would need a cross-service call, deferred
// until this view proves useful enough to justify it.
export async function getBadgeSummary(days) {
  const n = daysParam(days);
  const [{ rows: totals }, { rows: byGym }] = await Promise.all([
    query(
      `SELECT count(*)::int AS total_badges,
              count(DISTINCT distinct_id)::int AS unique_customers
         FROM analytics_events
        WHERE event = 'badge_earned' AND ts > now() - ($1 || ' days')::interval`,
      [n]
    ),
    query(
      `SELECT (properties->>'gym_id')::int AS gym_id,
              COALESCE(properties->>'city', 'Unknown') AS city,
              count(*)::int AS badges
         FROM analytics_events
        WHERE event = 'badge_earned' AND ts > now() - ($1 || ' days')::interval
        GROUP BY 1, 2
        ORDER BY badges ASC`,
      [n]
    ),
  ]);
  const t = totals[0] || { total_badges: 0, unique_customers: 0 };
  return {
    totalBadges: t.total_badges,
    uniqueCustomers: t.unique_customers,
    byGym: byGym.map((r) => ({ gymId: r.gym_id, city: r.city, badges: r.badges })),
  };
}

// ---- Revenue / GMV trend -------------------------------------------------------

export async function getRevenueTrend(days) {
  const n = daysParam(days);
  const { rows } = await query(
    `SELECT date_trunc('day', ts) AS day,
            count(*)::int AS bookings,
            COALESCE(sum((properties->>'amount')::numeric), 0)::float AS gmv
       FROM analytics_events
      WHERE event = 'booking_confirmed' AND ts > now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [n]
  );
  return { days: rows };
}

// ---- Gym-scoped revenue trend (partner-facing) -------------------------------

// Per-gym equivalent of getRevenueTrend — daily bookings/GMV for one gym,
// so a partner can see a trend line instead of just today/week/month/year
// tiles (see partner-web/partner-app dashboard).
export async function getGymRevenueTrend(gymId, days) {
  const n = daysParam(days);
  const { rows } = await query(
    `SELECT date_trunc('day', ts) AS day,
            count(*)::int AS bookings,
            COALESCE(sum((properties->>'amount')::numeric), 0)::float AS gmv
       FROM analytics_events
      WHERE event = 'booking_confirmed' AND properties->>'gym_id' = $1
        AND ts > now() - ($2 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [String(gymId), n]
  );
  return { days: rows };
}

// ---- Website traffic (footfall) ---------------------------------------------

// The website (lib/analytics.ts) posts session_started once per tab session
// and screen_viewed on every route change, both tagged properties.app =
// 'website' — there's no separate page-view pixel or GA wired up, so this
// analytics_events table is the only footfall signal that exists. Unique
// visitors is distinct_id (anon_xxx pre-login, resolved to the real user id
// post-identify — see getUserJourney's anon-id resolution above for why that
// matters for journey lookups but is left alone here: a rough visitor count
// doesn't need that resolution, it would only double-count as "one more
// person" for the same person before/after login on the same device).

// Country/city arrive stamped on every website event by the website's own
// /api/events BFF route (Vercel edge geo headers), as geo_country /
// geo_city. Rows before that shipped have neither property — they simply
// don't match a country/city filter (visible under "All countries" only),
// which getWebsiteTraffic's geoCoverage count makes explicit in the UI
// rather than leaving an empty dashboard looking broken. Bound params
// throughout; the slice() just keeps absurd inputs out of the DB round-trip.
function geoClauses(country, city, params) {
  let clauses = '';
  if (country) {
    const idx = params.push(String(country).slice(0, 100));
    clauses += ` AND properties->>'geo_country' = $${idx}`;
  }
  if (city) {
    const idx = params.push(String(city).slice(0, 100));
    clauses += ` AND properties->>'geo_city' = $${idx}`;
  }
  return clauses;
}

export async function getWebsiteTraffic(days, country, city) {
  const n = daysParam(days);
  // Same param array reused by every query below — each statement numbers its
  // placeholders from $1, so the indices stay valid per-statement.
  const params = [n];
  const geo = geoClauses(country, city, params);
  const { rows: totals } = await query(
    `SELECT event, count(*)::int AS n, count(DISTINCT distinct_id)::int AS distinct_users
       FROM analytics_events
      WHERE event IN ('session_started', 'screen_viewed')
        AND properties->>'app' = 'website'
        AND ts > now() - ($1 || ' days')::interval${geo}
      GROUP BY event`,
    params
  );
  const { rows: daily } = await query(
    `SELECT date_trunc('day', ts) AS day, event, count(*)::int AS n
       FROM analytics_events
      WHERE event IN ('session_started', 'screen_viewed')
        AND properties->>'app' = 'website'
        AND ts > now() - ($1 || ' days')::interval${geo}
      GROUP BY 1, 2 ORDER BY 1`,
    params
  );
  const { rows: topPages } = await query(
    `SELECT properties->>'screen_name' AS page, count(*)::int AS views
       FROM analytics_events
      WHERE event = 'screen_viewed' AND properties->>'app' = 'website'
        AND ts > now() - ($1 || ' days')::interval${geo}
      GROUP BY 1 ORDER BY views DESC LIMIT 15`,
    params
  );

  // How visitors landed — session_started carries this (see lib/analytics.ts's
  // getLandingContext, added 2026-08-15), captured once at the very first
  // paint of a session so it reflects the actual entry point, not wherever a
  // visitor happened to be when session_started's SQL got queried.
  const { rows: channels } = await query(
    `SELECT COALESCE(properties->>'channel', 'unknown') AS channel,
            count(*)::int AS sessions,
            count(DISTINCT distinct_id)::int AS distinct_visitors
       FROM analytics_events
      WHERE event = 'session_started' AND properties->>'app' = 'website'
        AND ts > now() - ($1 || ' days')::interval${geo}
      GROUP BY 1 ORDER BY sessions DESC`,
    params
  );
  const { rows: referrers } = await query(
    `SELECT properties->>'referrer_host' AS referrer_host, count(*)::int AS sessions
       FROM analytics_events
      WHERE event = 'session_started' AND properties->>'app' = 'website'
        AND properties->>'referrer_host' IS NOT NULL
        AND ts > now() - ($1 || ' days')::interval${geo}
      GROUP BY 1 ORDER BY sessions DESC LIMIT 15`,
    params
  );
  const { rows: campaigns } = await query(
    `SELECT properties->>'utm_source' AS utm_source,
            properties->>'utm_campaign' AS utm_campaign,
            count(*)::int AS sessions
       FROM analytics_events
      WHERE event = 'session_started' AND properties->>'app' = 'website'
        AND properties->>'utm_source' IS NOT NULL
        AND ts > now() - ($1 || ' days')::interval${geo}
      GROUP BY 1, 2 ORDER BY sessions DESC LIMIT 15`,
    params
  );
  const { rows: landingPages } = await query(
    `SELECT properties->>'landing_path' AS landing_path, count(*)::int AS sessions
       FROM analytics_events
      WHERE event = 'session_started' AND properties->>'app' = 'website'
        AND properties->>'landing_path' IS NOT NULL
        AND ts > now() - ($1 || ' days')::interval${geo}
      GROUP BY 1 ORDER BY sessions DESC LIMIT 15`,
    params
  );

  // Coverage of the geo tag itself over ALL sessions in the window (never
  // geo-filtered): tells the admin how much of what they're looking at
  // predates location stamping, so an India-filtered near-zero reads as
  // "tagging started recently", not "traffic stopped".
  const { rows: coverageRows } = await query(
    `SELECT count(*) FILTER (WHERE properties->>'geo_country' IS NOT NULL)::int AS tagged,
            count(*) FILTER (WHERE properties->>'geo_country' IS NULL)::int AS untagged
       FROM analytics_events
      WHERE event = 'session_started' AND properties->>'app' = 'website'
        AND ts > now() - ($1 || ' days')::interval`,
    [n]
  );
  const coverage = coverageRows[0] || { tagged: 0, untagged: 0 };

  const sessions = totals.find((r) => r.event === 'session_started');
  const pageviews = totals.find((r) => r.event === 'screen_viewed');
  return {
    totalSessions: sessions?.n ?? 0,
    uniqueVisitors: sessions?.distinct_users ?? 0,
    totalPageViews: pageviews?.n ?? 0,
    daily,
    topPages,
    channels,
    referrers,
    campaigns,
    landingPages,
    geoCoverage: { tagged: coverage.tagged, untagged: coverage.untagged },
  };
}

// ---- Supply health: approved gyms with little/no booking activity -------------

// Surfaces "dead weight" supply — a gym that got approved but never converted
// into real bookings — which matters more than raw approval counts when the
// launch bottleneck is real, active supply, not just approval throughput.
// 7-day grace period: a gym approved yesterday having zero bookings yet isn't
// a signal of anything, it just hasn't had time.
export async function getSupplyHealth() {
  const { rows } = await query(
    `WITH approved AS (
       SELECT DISTINCT ON (properties->>'gym_id')
              properties->>'gym_id' AS gym_id, ts AS approved_ts, properties->>'city' AS city
         FROM analytics_events
        WHERE event = 'gym_approved'
        ORDER BY properties->>'gym_id', ts DESC
     ),
     bookings AS (
       SELECT properties->>'gym_id' AS gym_id, count(*)::int AS booking_count, max(ts) AS last_booking_ts
         FROM analytics_events
        WHERE event = 'booking_confirmed'
        GROUP BY 1
     )
     SELECT a.gym_id, a.approved_ts, a.city,
            COALESCE(b.booking_count, 0) AS booking_count, b.last_booking_ts
       FROM approved a
       LEFT JOIN bookings b ON b.gym_id = a.gym_id
      WHERE a.approved_ts < now() - interval '7 days'
      ORDER BY booking_count ASC, a.approved_ts ASC`
  );
  return { gyms: rows };
}

// ---- Location reach: can a visitor even reach a gym? ------------------------

// Distinct from listGyms' MAX_DISTANCE_KM cutoff (a business rule for what
// shows in discovery) — this reads location_resolved, which carries the TRUE
// nearest-gym distance the website computed via /api/gyms/nearest-distance,
// so "browsed but never booked" can be explained by "there's nothing within
// reach" rather than looking identical to "location permission was never
// granted." Bucket bounds below are fixed constants, not user input, so
// interpolating them directly into the SQL is safe — same convention as
// getCustomFunnel's generated CTE aliases.
const REACH_BUCKETS = [
  { label: '0-1km', min: 0, max: 1 },
  { label: '1-2km', min: 1, max: 2 },
  { label: '2-3km', min: 2, max: 3 },
  { label: '3-4km', min: 3, max: 4 },
  { label: '4-5km', min: 4, max: 5 },
  { label: '5-6km', min: 5, max: 6 },
  { label: '6-10km', min: 6, max: 10 },
  { label: '10-30km', min: 10, max: 30 },
  { label: '30km+', min: 30, max: null },
];

export async function getLocationReach(days, limit) {
  const n = daysParam(days);
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const { rows: permission } = await query(
    `SELECT properties->>'permission' AS permission,
            count(*)::int AS n,
            count(DISTINCT distinct_id)::int AS distinct_visitors
       FROM analytics_events
      WHERE event = 'location_resolved' AND ts > now() - ($1 || ' days')::interval
      GROUP BY 1`,
    [n]
  );

  const { rows: distanceStats } = await query(
    `SELECT count(*)::int AS n,
            avg((properties->>'nearest_gym_distance_km')::numeric)::float AS avg_km,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY (properties->>'nearest_gym_distance_km')::numeric)::float AS median_km
       FROM analytics_events
      WHERE event = 'location_resolved'
        AND properties->>'nearest_gym_distance_km' IS NOT NULL
        AND ts > now() - ($1 || ' days')::interval`,
    [n]
  );

  const bucketSelect = REACH_BUCKETS
    .map((b, i) => {
      const lower = `(properties->>'nearest_gym_distance_km')::numeric >= ${b.min}`;
      const upper = b.max != null ? ` AND (properties->>'nearest_gym_distance_km')::numeric < ${b.max}` : '';
      return `count(*) FILTER (WHERE ${lower}${upper})::int AS bucket_${i}`;
    })
    .join(',\n            ');
  const { rows: bucketRows } = await query(
    `SELECT ${bucketSelect}
       FROM analytics_events
      WHERE event = 'location_resolved'
        AND properties->>'nearest_gym_distance_km' IS NOT NULL
        AND ts > now() - ($1 || ' days')::interval`,
    [n]
  );
  const bucketCounts = bucketRows[0] || {};
  const buckets = REACH_BUCKETS.map((b, i) => ({ label: b.label, count: bucketCounts[`bucket_${i}`] ?? 0 }));

  // Every distinct visitor's most recent resolution — "for every user, how
  // close was the nearest gym" answered one row at a time, not just as an
  // aggregate. FILTER on the array_agg drops null distances (denied/
  // unsupported/timeout/error rows) so a visitor's last GRANTED distance
  // still surfaces even if their most recent event was a later denial.
  const { rows: visitors } = await query(
    `SELECT distinct_id,
            max(ts) AS last_seen,
            (array_agg(properties->>'permission' ORDER BY ts DESC))[1] AS permission,
            (array_agg((properties->>'nearest_gym_distance_km')::float ORDER BY ts DESC)
              FILTER (WHERE properties->>'nearest_gym_distance_km' IS NOT NULL))[1] AS nearest_gym_distance_km
       FROM analytics_events
      WHERE event = 'location_resolved' AND ts > now() - ($1 || ' days')::interval
      GROUP BY distinct_id
      ORDER BY last_seen DESC
      LIMIT $2`,
    [n, cappedLimit]
  );

  return {
    permission,
    distance: {
      resolvedCount: distanceStats[0]?.n ?? 0,
      avgKm: distanceStats[0]?.avg_km ?? null,
      medianKm: distanceStats[0]?.median_km ?? null,
      buckets,
    },
    visitors,
  };
}

// ---- Suggestion sources (event/property/value autocomplete) ----------------

// Backs the Event Search and Custom Funnel builders' event-name field —
// real events that have actually occurred, most frequent first, rather than
// a hardcoded schema list. Mirrors how CleverTap's segment builder only
// offers events present in the account's own data.
export async function getKnownEvents(limit) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await query(
    `SELECT event, count(*)::int AS n FROM analytics_events GROUP BY event ORDER BY n DESC LIMIT $1`,
    [cappedLimit]
  );
  return { events: rows };
}

// jsonb_object_keys is a set-returning function — used directly in the SELECT
// list here (a supported, if legacy, Postgres pattern) rather than a LATERAL
// join, since there's nothing else in the row to correlate against. Excludes
// keys that are noise as a filter dimension (unique-ish per row, or raw
// strings nobody buckets on) — same reasoning as HIDDEN_INLINE_PROPS in the
// admin's journey timeline, kept independently since this list is about
// what's worth filtering on, not what's worth displaying inline.
const NOISY_PROPERTY_KEYS = ['ip', 'user_agent', 'session_id'];

export async function getKnownPropertyKeys(event, limit) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await query(
    `SELECT DISTINCT jsonb_object_keys(properties) AS key
       FROM analytics_events
      WHERE event = $1
      LIMIT $2`,
    [event, cappedLimit]
  );
  return { keys: rows.map((r) => r.key).filter((k) => !NOISY_PROPERTY_KEYS.includes(k)).sort() };
}

// The actual "suggest a value" step — scoped to one event+key pair, since
// values for e.g. screen_name and cta don't mean anything mixed together.
// Counts included so the UI can show "most common first," same as
// CleverTap's value picker. filterKey/filterValue optionally narrow the rows
// before grouping (e.g. key=geo_city scoped to filterKey=geo_country,
// filterValue=India so the traffic view's city dropdown lists only cities
// actually seen in the selected country) — same bound-param treatment as
// everything else, so even the scope key can't inject SQL.
export async function getKnownPropertyValues(event, key, limit, filterKey, filterValue) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const params = [event, key];
  let scopeClauses = '';
  if (filterKey && filterValue) {
    const keyIdx = params.push(String(filterKey).slice(0, 100));
    const valueIdx = params.push(String(filterValue).slice(0, 200));
    scopeClauses = ` AND properties ->> $${keyIdx} = $${valueIdx}`;
  }
  const limitIdx = params.push(cappedLimit);
  const { rows } = await query(
    `SELECT properties ->> $2 AS value, count(*)::int AS n
       FROM analytics_events
      WHERE event = $1 AND properties ->> $2 IS NOT NULL${scopeClauses}
      GROUP BY 1
      ORDER BY n DESC
      LIMIT $${limitIdx}`,
    params
  );
  return { values: rows };
}

// ---- Recent anonymous (pre-signup) sessions --------------------------------

// Anon distinct_ids (website's lib/analytics.ts / both apps' AnalyticsService
// mint `anon_...` before login) have no phone to search by, so the Lookup
// tab's phone-resolve path can never find them — this is the only way to
// discover one to look up at all. last_screen/app are just a cheap preview
// (most-recent non-null value per group) so the admin can tell which row is
// worth opening before committing to a full journey fetch.
export async function getRecentAnonSessions(days, limit) {
  const n = daysParam(days || 7); // narrower default than the journey lookup — this is "who's active lately," not a full history
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const { rows } = await query(
    `SELECT distinct_id,
            min(ts) AS first_seen,
            max(ts) AS last_seen,
            count(*)::int AS event_count,
            count(DISTINCT properties->>'session_id')::int AS session_count,
            (array_agg(properties->>'screen_name' ORDER BY ts DESC) FILTER (WHERE properties->>'screen_name' IS NOT NULL))[1] AS last_screen,
            (array_agg(properties->>'app' ORDER BY ts DESC) FILTER (WHERE properties->>'app' IS NOT NULL))[1] AS app
       FROM analytics_events
      WHERE distinct_id LIKE 'anon\_%' AND ts > now() - ($1 || ' days')::interval
      GROUP BY distinct_id
      ORDER BY last_seen DESC
      LIMIT $2`,
    [n, cappedLimit]
  );
  return { sessions: rows };
}

// ---- Event search (find users, not a specific one) -------------------------

// The counterpart to getRecentAnonSessions for signed-up users: "which users
// did X" rather than "what did user X do." Same shape (grouped by
// distinct_id, most recent first) but for any event + optional exact-match
// property filters, not just the anon-id special case.
export async function searchEventUsers(event, filters, days, limit) {
  const n = daysParam(days || 30);
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const params = [event];
  let filterClauses = '';
  for (const [key, value] of Object.entries(filters || {})) {
    params.push(key);
    params.push(value);
    filterClauses += ` AND properties ->> $${params.length - 1} = $${params.length}`;
  }
  const daysIdx = params.push(n);
  const limitIdx = params.push(cappedLimit);
  const { rows } = await query(
    `SELECT distinct_id,
            min(ts) AS first_seen,
            max(ts) AS last_seen,
            count(*)::int AS event_count
       FROM analytics_events
      WHERE event = $1 AND ts > now() - ($${daysIdx} || ' days')::interval${filterClauses}
      GROUP BY distinct_id
      ORDER BY last_seen DESC
      LIMIT $${limitIdx}`,
    params
  );
  return { users: rows };
}

// ---- Custom funnels (admin-defined, true sequential order) -----------------

// Unlike the hardcoded funnels above (independent per-event counts in the
// same window), this enforces real order: step N only counts a distinct_id
// if it matched step N-1 at an earlier ts. Built as a chain of CTEs, one per
// step, each joining the previous step's surviving distinct_ids against a
// later occurrence of its own event. Event names and filter keys/values are
// all bound params — ->> takes its key as a plain text operand, so even the
// filter *keys* are safely parameterizable, not just the values. Only the
// window bound (step 0 only — later steps have no time ceiling, matching
// "of everyone who started in the window, how many eventually did each next
// step") and the generated CTE aliases (step0, step1, ... — ordinal, never
// derived from user input) are interpolated directly.
export async function getCustomFunnel(steps, days) {
  const n = daysParam(days || 30);
  const params = [];
  const ctes = steps.map((step, i) => {
    const eventIdx = params.push(step.event);
    let filterClauses = '';
    for (const [key, value] of Object.entries(step.filters || {})) {
      const keyIdx = params.push(key);
      const valueIdx = params.push(value);
      filterClauses += ` AND e.properties ->> $${keyIdx} = $${valueIdx}`;
    }
    if (i === 0) {
      const daysIdx = params.push(n);
      return `step0 AS (
        SELECT distinct_id, min(ts) AS ts0
          FROM analytics_events e
         WHERE e.event = $${eventIdx} AND e.ts > now() - ($${daysIdx} || ' days')::interval${filterClauses}
         GROUP BY distinct_id
      )`;
    }
    return `step${i} AS (
      SELECT p.distinct_id, min(e.ts) AS ts${i}
        FROM step${i - 1} p
        JOIN analytics_events e ON e.distinct_id = p.distinct_id AND e.event = $${eventIdx} AND e.ts > p.ts${i - 1}${filterClauses}
       GROUP BY p.distinct_id
    )`;
  });
  const counts = steps.map((_, i) => `SELECT ${i} AS step_index, count(*)::int AS users FROM step${i}`).join(' UNION ALL ');
  const { rows } = await query(`WITH ${ctes.join(',\n')} ${counts} ORDER BY step_index`, params);
  const byIndex = new Map(rows.map((r) => [r.step_index, r.users]));
  return { steps: steps.map((s, i) => ({ event: s.event, filters: s.filters || {}, users: byIndex.get(i) ?? 0 })) };
}

// ---- Per-user journey --------------------------------------------------------

// Every event for one distinct_id, oldest first, interleaving client intent and
// server truth in one timeline (deliberately not split into separate feeds —
// seeing "viewed gym" next to the server's "booking_confirmed" a moment later
// is the point). Session boundaries aren't computed here; the caller detects a
// session_id change between consecutive rows to render a divider, since that's
// cheap array logic and keeps this endpoint's shape reusable.
//
// Pre-login events (session_started, the landing screen_viewed) are always
// posted under the browser's anon_xxx id, since identify() only swaps the
// client's in-memory distinct_id to the real user id once the session cookie
// check resolves (see website lib/analytics.ts). Every identify event this
// user ever fired recorded which anon id it came from in
// properties.anon_distinct_id, so we resolve that set first and pull those
// anon-tagged rows into the same timeline — otherwise a logged-in user's
// journey looks like nothing but a string of bare "identify" events.
export async function getUserJourney(distinctId, days) {
  const n = daysParam(days || 90); // wider default window than the funnel views — a journey lookup is usually "show me everything"
  const { rows } = await query(
    `WITH anon_ids AS (
       SELECT DISTINCT properties->>'anon_distinct_id' AS anon_id
         FROM analytics_events
        WHERE event = 'identify' AND distinct_id = $1 AND properties->>'anon_distinct_id' IS NOT NULL
     )
       SELECT event, properties, source, service, ts
         FROM analytics_events
        WHERE (distinct_id = $1 OR distinct_id IN (SELECT anon_id FROM anon_ids))
          AND ts > now() - ($2 || ' days')::interval
        ORDER BY ts ASC`,
    [distinctId, n]
  );
  const sessionIds = new Set(rows.map((r) => r.properties?.session_id).filter(Boolean));
  return {
    events: rows,
    summary: {
      totalEvents: rows.length,
      firstSeen: rows[0]?.ts ?? null,
      lastSeen: rows[rows.length - 1]?.ts ?? null,
      apps: [...new Set(rows.map((r) => r.properties?.app).filter(Boolean))],
      services: [...new Set(rows.map((r) => r.service).filter(Boolean))],
      sessionCount: sessionIds.size,
    },
  };
}

// Resolves a numeric distinct_id to a real name/phone via auth-service's
// existing internal lookup (same endpoint bookingService.js already calls for
// profile checks) — fails open to null, since an anon_xxx id, a manual test
// id, or a lookup failure should never break the journey view, just leave the
// identity section showing "unknown."
// Same 10-digit normalization authService.js's normalizePhone uses, so
// "+919354859197", "919354859197", and "9354859197" are all recognized as
// phone input rather than a raw distinct_id.
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

// Lets the admin portal's journey search box take a phone number in place of
// a distinct_id — resolves it to the numeric user id via auth-service, since
// analytics_events keys journeys on distinct_id (== auth user id for logged-in
// users), not phone. Returns null (not the phone string) when nothing matches,
// so the caller can tell "no such user" apart from "search by this id".
export async function resolveDistinctIdFromSearch(rawInput) {
  const phone = normalizePhone(rawInput);
  if (!phone) return String(rawInput);
  try {
    const headers = { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(AUTH_SERVICE_URL)) };
    const res = await axios.get(`${AUTH_SERVICE_URL}/internal/by-phone/${phone}`, { headers });
    const user = res.data?.data || res.data;
    return user?.id != null ? String(user.id) : null;
  } catch (_) {
    return null;
  }
}

export async function getUserProfile(distinctId) {
  if (!/^\d+$/.test(String(distinctId))) return null;
  try {
    const headers = { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(AUTH_SERVICE_URL)) };
    const res = await axios.get(`${AUTH_SERVICE_URL}/internal/${distinctId}`, { headers });
    const profile = res.data?.data || res.data;
    if (!profile) return null;
    return {
      name: profile.name ?? null,
      phone: profile.phone ?? null,
      role: profile.role ?? null,
      type: profile.type ?? null,
    };
  } catch (_) {
    return null;
  }
}

// ---- Generic daily trend for any event(s) -----------------------------------

export async function getTrend(metric, days) {
  const n = daysParam(days);
  const events = String(metric || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (events.length === 0) return { days: [] };
  const { rows } = await query(
    `SELECT date_trunc('day', ts) AS day, event, count(*)::int AS n, count(DISTINCT distinct_id)::int AS distinct_users
       FROM analytics_events
      WHERE event = ANY($1) AND ts > now() - ($2 || ' days')::interval
      GROUP BY 1, 2 ORDER BY 1`,
    [events, n]
  );
  return { days: rows };
}

// ---- Weekly cohort retention -------------------------------------------------
//
// Answers "of customers whose first booking landed in week W, what fraction
// still booked again N weeks later" — the thing the funnel-only dashboards
// can't answer (a healthy top-of-funnel can hide a leaky cohort). Deliberately
// scoped to booking_confirmed only (not every event) since a repeat booking is
// the one signal that actually means "came back and paid again," not just
// "opened the app." Capped at 8 weeks of offset and the last `cohortWeeks`
// cohorts so this stays a small table, not an unbounded triangle.
const RETENTION_MAX_WEEK_OFFSET = 8;

export async function getRetentionCohorts(cohortWeeks) {
  const weeks = Number(cohortWeeks);
  const n = Number.isFinite(weeks) && weeks > 0 && weeks <= 26 ? weeks : 12;
  const { rows } = await query(
    `WITH first_booking AS (
       SELECT distinct_id, date_trunc('week', min(ts)) AS cohort_week
         FROM analytics_events
        WHERE event = 'booking_confirmed'
        GROUP BY distinct_id
     ),
     activity AS (
       SELECT distinct_id, date_trunc('week', ts) AS activity_week
         FROM analytics_events
        WHERE event = 'booking_confirmed'
        GROUP BY distinct_id, date_trunc('week', ts)
     )
     SELECT
       fb.cohort_week,
       count(DISTINCT fb.distinct_id)::int AS cohort_size,
       floor(extract(epoch FROM (a.activity_week - fb.cohort_week)) / 604800)::int AS week_offset,
       count(DISTINCT a.distinct_id)::int AS active_users
     FROM first_booking fb
     JOIN activity a ON a.distinct_id = fb.distinct_id AND a.activity_week >= fb.cohort_week
    WHERE fb.cohort_week > now() - ($1 || ' weeks')::interval
    GROUP BY fb.cohort_week, week_offset
   ORDER BY fb.cohort_week, week_offset`,
    [n]
  );

  const cohortsByWeek = new Map();
  for (const row of rows) {
    if (row.week_offset > RETENTION_MAX_WEEK_OFFSET) continue;
    const key = row.cohort_week.toISOString();
    if (!cohortsByWeek.has(key)) {
      cohortsByWeek.set(key, { cohortWeek: row.cohort_week, cohortSize: row.cohort_size, weeks: [] });
    }
    const cohort = cohortsByWeek.get(key);
    cohort.weeks.push({
      offset: row.week_offset,
      activeUsers: row.active_users,
      retentionRate: cohort.cohortSize ? row.active_users / cohort.cohortSize : null,
    });
  }
  return { cohorts: [...cohortsByWeek.values()] };
}

// ---- Gym-scoped weekly cohort retention (partner-facing) --------------------

// Same "did they come back" question as getRetentionCohorts, but cohorted on
// a customer's first booking AT THIS GYM specifically, not their first
// booking anywhere on the platform — the number a gym owner actually wants
// ("do people who try my gym come back to MY gym") is different from the
// platform-wide figure gobhi tracks.
export async function getGymRetentionCohorts(gymId, cohortWeeks) {
  const weeks = Number(cohortWeeks);
  const n = Number.isFinite(weeks) && weeks > 0 && weeks <= 26 ? weeks : 12;
  const { rows } = await query(
    `WITH first_booking AS (
       SELECT distinct_id, date_trunc('week', min(ts)) AS cohort_week
         FROM analytics_events
        WHERE event = 'booking_confirmed' AND properties->>'gym_id' = $2
        GROUP BY distinct_id
     ),
     activity AS (
       SELECT distinct_id, date_trunc('week', ts) AS activity_week
         FROM analytics_events
        WHERE event = 'booking_confirmed' AND properties->>'gym_id' = $2
        GROUP BY distinct_id, date_trunc('week', ts)
     )
     SELECT
       fb.cohort_week,
       count(DISTINCT fb.distinct_id)::int AS cohort_size,
       floor(extract(epoch FROM (a.activity_week - fb.cohort_week)) / 604800)::int AS week_offset,
       count(DISTINCT a.distinct_id)::int AS active_users
     FROM first_booking fb
     JOIN activity a ON a.distinct_id = fb.distinct_id AND a.activity_week >= fb.cohort_week
    WHERE fb.cohort_week > now() - ($1 || ' weeks')::interval
    GROUP BY fb.cohort_week, week_offset
   ORDER BY fb.cohort_week, week_offset`,
    [n, String(gymId)]
  );

  const cohortsByWeek = new Map();
  for (const row of rows) {
    if (row.week_offset > RETENTION_MAX_WEEK_OFFSET) continue;
    const key = row.cohort_week.toISOString();
    if (!cohortsByWeek.has(key)) {
      cohortsByWeek.set(key, { cohortWeek: row.cohort_week, cohortSize: row.cohort_size, weeks: [] });
    }
    const cohort = cohortsByWeek.get(key);
    cohort.weeks.push({
      offset: row.week_offset,
      activeUsers: row.active_users,
      retentionRate: cohort.cohortSize ? row.active_users / cohort.cohortSize : null,
    });
  }
  return { cohorts: [...cohortsByWeek.values()] };
}
