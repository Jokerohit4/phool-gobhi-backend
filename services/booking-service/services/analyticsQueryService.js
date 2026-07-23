import pg from 'pg';

const { Pool } = pg;

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
