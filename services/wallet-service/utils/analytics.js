// Vendor-neutral, fire-and-forget event tracking.
//
// The sink is chosen by the ANALYTICS_PROVIDER env var:
//   'none'    (default) — no-op; safe to ship before analytics is configured
//   'console'           — logs each event as JSON (use in dev to verify the funnel)
//   'postgres'          — appends to an analytics_events table in ANALYTICS_DATABASE_URL
//                         (first-party: we own the data; query funnels with SQL)
//   'posthog'           — POSTs to PostHog's free HTTP capture API (no SDK dependency)
//
// Design rules:
//   - track()/ingest() NEVER throw and NEVER block the request path (fire-and-forget).
//   - We send userId as distinct_id and avoid PII (no phone/email/name in properties).
//   - Adding/removing a sink is a change here only; no call site changes.
const PROVIDER = (process.env.ANALYTICS_PROVIDER || 'none').toLowerCase();
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const POSTHOG_KEY = process.env.POSTHOG_API_KEY || '';
const SERVICE = process.env.ANALYTICS_SERVICE_NAME || 'backend';

// ---- postgres sink (first-party) -------------------------------------------
let _pool = null;
let _pgModule = null;
let _tableReady = null;

async function getPool() {
  if (_pool) return _pool;
  const url = process.env.ANALYTICS_DATABASE_URL;
  if (!url) return null;
  _pgModule = _pgModule || (await import('pg')).default;
  _pool = new _pgModule.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  return _pool;
}

async function ensureTable(pool) {
  if (_tableReady) return _tableReady;
  _tableReady = pool
    .query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id          BIGSERIAL PRIMARY KEY,
        event       TEXT NOT NULL,
        distinct_id TEXT,
        properties  JSONB NOT NULL DEFAULT '{}',
        source      TEXT,
        service     TEXT,
        ts          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `)
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_analytics_events_event_ts ON analytics_events(event, ts);`
      )
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_analytics_events_distinct ON analytics_events(distinct_id);`
      )
    )
    .catch((err) => {
      console.error('[analytics] ensureTable failed:', err.message);
      _tableReady = null; // allow a later retry
    });
  return _tableReady;
}

async function sendToPostgres(event, distinctId, properties, source) {
  try {
    const pool = await getPool();
    if (!pool) return;
    await ensureTable(pool);
    await pool.query(
      `INSERT INTO analytics_events(event, distinct_id, properties, source, service)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event,
        distinctId == null ? null : String(distinctId),
        JSON.stringify(properties || {}),
        source,
        SERVICE,
      ]
    );
  } catch (err) {
    console.error('[analytics] postgres send failed:', err.message);
  }
}

// ---- posthog sink ----------------------------------------------------------
async function sendToPostHog(event, distinctId, properties, source) {
  if (!POSTHOG_KEY) return;
  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: String(distinctId ?? 'anonymous'),
        properties: { ...properties, source, service: SERVICE },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('[analytics] posthog send failed:', err.message);
  }
}

// ---- dispatch --------------------------------------------------------------
function emit(event, distinctId, properties, source) {
  try {
    if (PROVIDER === 'none') return;
    if (PROVIDER === 'console') {
      console.log(
        `[analytics] ${event} ` +
          JSON.stringify({ distinct_id: String(distinctId ?? 'anonymous'), source, service: SERVICE, ...properties })
      );
      return;
    }
    if (PROVIDER === 'postgres') {
      sendToPostgres(event, distinctId, properties, source); // not awaited
      return;
    }
    if (PROVIDER === 'posthog') {
      sendToPostHog(event, distinctId, properties, source); // not awaited
    }
  } catch (err) {
    console.error('[analytics] emit failed:', err.message);
  }
}

/**
 * Record a server-truth event. Safe to call anywhere — failures are swallowed.
 */
export function track(event, distinctId, properties = {}) {
  emit(event, distinctId, properties, 'server');
}

/**
 * Ingest an event reported by a client (used by the gateway's /api/events route).
 * `source` defaults to 'client'.
 */
export function ingest({ event, distinctId, properties = {}, source = 'client' }) {
  emit(event, distinctId, properties, source);
}

export default { track, ingest };
