// Canonical, request-scoped first-party transport. Vendored into service builds
// by tools/analytics/sync.mjs; do not edit a service copy independently.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

export const PROPERTY_KEYS = 'amount anon_distinct_id app channel city geo_city geo_country granted gym_id landing_path method nearest_gym_distance_km permission reason referrer_host screen_name session_id step surface training_location utm_campaign utm_source'.split(' ');
const requests = new AsyncLocalStorage();
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], projectId: process.env.GOOGLE_CLOUD_PROJECT || 'phool-gobhi' });
let authClient;
const outside = new Set();

export function analyticsEnvironment() {
  const environment = process.env.ANALYTICS_ENVIRONMENT || process.env.K_SERVICE?.match(/-(dev|prod)$/)?.[1];
  if (!['dev', 'prod'].includes(environment)) throw Error('ANALYTICS_ENVIRONMENT must be dev or prod');
  return environment;
}

export function eventEnvelope({ event, distinctId, properties = {}, source = 'server', service, eventId, timestamp, legacyId }) {
  if (typeof event !== 'string' || !event || event.length > 200) throw Error('invalid analytics event');
  const safe = { ...properties };
  // Neither raw field participates in a report. Preserve historical data during
  // backfill, but stop collecting these identifiers in the new live transport.
  delete safe.ip;
  delete safe.user_agent;
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized) > 65536) throw Error('analytics properties exceed 64KiB');
  const row = { event_id: eventId || randomUUID(), event, distinct_id: distinctId == null ? null : String(distinctId),
    properties: serialized, source, service: service || process.env.ANALYTICS_SERVICE_NAME || 'backend',
    environment: analyticsEnvironment(), ts: new Date(timestamp || Date.now()).toISOString(),
    ingested_at: new Date().toISOString(), legacy_id: legacyId == null ? null : String(legacyId) };
  for (const key of PROPERTY_KEYS) {
    const value = safe[key];
    row['p_' + key] = value == null || typeof value === 'object' ? null : String(value);
  }
  return row;
}

function recordFailure() {
  // No payload, identity, token, URL or raw provider exception in logs.
  console.error(JSON.stringify({ severity: 'ERROR', component: 'analytics', code: 'ANALYTICS_PUBLISH_FAILED' }));
}

export async function publishRows(rows, { client, topic = process.env.ANALYTICS_TOPIC } = {}) {
  if (!rows.length) return;
  if (!/^projects\/[a-z][a-z0-9-]+\/topics\/analytics-events-(dev|prod)$/.test(topic || '')) throw Error('invalid analytics topic');
  if (!topic.endsWith('-' + analyticsEnvironment())) throw Error('analytics environment/topic mismatch');
  const transport = client || await (authClient ||= auth.getClient());
  for (let start = 0; start < rows.length; start += 100) {
    const messages = rows.slice(start, start + 100).map(row => ({ data: Buffer.from(JSON.stringify(row)).toString('base64') }));
    let delivered = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await transport.request({ url: `https://pubsub.googleapis.com/v1/${topic}:publish`,
          method: 'POST', data: { messages }, timeout: 1500, retry: false });
        if (response.data?.messageIds?.length !== messages.length) throw Error('missing publish acknowledgement');
        delivered = true;
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!delivered) throw Error('analytics publish failed');
  }
}

export function enqueueWarehouse(rowOrPromise) {
  const scope = requests.getStore();
  const pending = Promise.resolve(rowOrPromise);
  if (scope && !scope.closed) {
    // Attach a rejection handler immediately, even before response draining.
    scope.rows.push(pending.then(row => ({ row }), () => ({ failed: true })));
    return;
  }
  const task = pending.then(row => publishRows([row])).catch(recordFailure);
  outside.add(task);
  task.finally(() => outside.delete(task));
}

export async function flushAnalytics() {
  await Promise.allSettled([...outside]);
}

export function analyticsMiddleware({ publish = publishRows, timeoutMs = 4000, beforeDrain } = {}) {
  return (req, res, next) => {
    if (!['bigquery', 'dual'].includes((process.env.ANALYTICS_PROVIDER || '').toLowerCase())) return next();
    requests.run({ rows: [], closed: false }, () => {
      const scope = requests.getStore();
      const end = res.end;
      let ending = false;
      res.end = function (...args) {
        if (ending) return this;
        ending = true;
        const drain = async () => {
          if (beforeDrain) await beforeDrain(req);
          const values = await Promise.all(scope.rows);
          if (values.some(value => value.failed)) throw Error('event preparation failed');
          await publish(values.map(value => value.row));
        };
        let timer;
        Promise.race([drain(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('analytics deadline')), timeoutMs); })])
          .catch(() => {
            recordFailure();
            // A client analytics 202 means durable Pub/Sub acceptance. Optional
            // server telemetry must not turn a successful payment/booking into a failure.
            if (/^\/api\/events\/?$/.test(req.path) && !res.headersSent) {
              res.statusCode = 503;
              res.setHeader('Retry-After', '5');
              args = [JSON.stringify({ error: 'ANALYTICS_UNAVAILABLE', retryable: true })];
              res.removeHeader('Content-Length');
              res.removeHeader('ETag');
            }
          }).finally(() => {
            clearTimeout(timer);
            scope.closed = true;
            end.apply(res, args);
          });
        return this;
      };
      next();
    });
  };
}

// Keep the legacy sink during the reversible migration window. It is never
// opened when BigQuery is the selected provider.
export function createAnalytics({ protectedEvents = new Set() } = {}) {
  const provider = (process.env.ANALYTICS_PROVIDER || 'none').toLowerCase();
  const service = process.env.ANALYTICS_SERVICE_NAME || 'backend';
  let pool;
  let tableReady;
  async function getPool() {
    if (pool) return pool;
    if (!process.env.ANALYTICS_DATABASE_URL) return null;
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: process.env.ANALYTICS_DATABASE_URL,
      ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    return pool;
  }
  async function ensureTable(database) {
    if (!tableReady) tableReady = database.query(`CREATE TABLE IF NOT EXISTS analytics_events (
      id BIGSERIAL PRIMARY KEY,event TEXT NOT NULL,distinct_id TEXT,properties JSONB NOT NULL DEFAULT '{}',
      source TEXT,service TEXT,ts TIMESTAMPTZ NOT NULL DEFAULT now())`).then(async () => {
      for (const ddl of [
        'CREATE INDEX IF NOT EXISTS idx_analytics_events_event_ts ON analytics_events(event, ts)',
        'CREATE INDEX IF NOT EXISTS idx_analytics_events_distinct ON analytics_events(distinct_id)',
        "CREATE INDEX IF NOT EXISTS idx_analytics_events_gym_id ON analytics_events (((properties->>'gym_id')))",
        "CREATE INDEX IF NOT EXISTS idx_analytics_events_step ON analytics_events (((properties->>'step')))",
      ]) await database.query(ddl);
    }).catch(error => { tableReady = null; throw error; });
    return tableReady;
  }
  async function prepareDual(row) {
    const database = await getPool();
    if (!database) throw Error('legacy analytics unavailable');
    // The migration provisions this nullable column/unique index once, before
    // dual mode. Unknown commit outcomes can therefore use the same event ID.
    const result = await database.query(`INSERT INTO analytics_events
      (event_id,event,distinct_id,properties,source,service,ts) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO UPDATE SET event_id=EXCLUDED.event_id RETURNING id`,
    [row.event_id,row.event,row.distinct_id,row.properties,row.source,row.service,row.ts]);
    return { ...row, legacy_id: String(result.rows[0].id) };
  }
  function emit(event, distinctId, properties, source, eventId, timestamp) {
    try {
      if (protectedEvents.has(event) && !['postgres','dual','bigquery'].includes(provider)) return;
      if (provider === 'none') return;
      if (provider === 'bigquery' || provider === 'dual') {
        const row = eventEnvelope({event,distinctId,properties,source,service,eventId,timestamp});
        enqueueWarehouse(provider === 'dual' ? prepareDual(row) : row);
        return;
      }
      if (provider === 'console') {
        console.log(`[analytics] ${event} ` + JSON.stringify({distinct_id:String(distinctId ?? 'anonymous'),source,service,...properties}));
        return;
      }
      if (provider === 'postgres') {
        (async () => {
          const database = await getPool();
          if (!database) return;
          await ensureTable(database);
          await database.query(`INSERT INTO analytics_events(event, distinct_id, properties, source, service) VALUES ($1,$2,$3,$4,$5)`,
            [event,distinctId == null ? null : String(distinctId),JSON.stringify(properties || {}),source,service]);
        })().catch(recordFailure);
        return;
      }
      if (provider === 'posthog' && process.env.POSTHOG_API_KEY) {
        fetch(`${process.env.POSTHOG_HOST || 'https://us.i.posthog.com'}/capture/`, {method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({api_key:process.env.POSTHOG_API_KEY,event,distinct_id:String(distinctId ?? 'anonymous'),
            properties:{...properties,source,service},timestamp:new Date().toISOString()})}).catch(recordFailure);
      }
    } catch {
      if (['bigquery','dual'].includes(provider)) enqueueWarehouse(Promise.reject(Error('invalid analytics envelope')));
      else recordFailure();
    }
  }
  return {
    track: (event, distinctId, properties = {}) => emit(event,distinctId,properties,'server'),
    ingest: ({event,distinctId,properties = {},source = 'client',eventId,timestamp}) => emit(event,distinctId,properties,source,eventId,timestamp),
    async deliverReceiptEvent(row) {
      if (!['postgres','dual','bigquery'].includes(provider)) throw Error('durable analytics requires a first-party provider');
      if (provider !== 'bigquery') {
        const database = await getPool();
        if (!database) throw Error('analytics database unavailable');
        await ensureTable(database);
        await insertReceiptEvent(database,row);
      }
      if (provider !== 'postgres') await publishRows([eventEnvelope({event:row.event,distinctId:row.userId,
        properties:{...row.properties,_delivery_id:row.eventId},source:'server',service:'auth-service',
        eventId:'receipt:'+row.eventId,timestamp:row.createdAt})]);
    },
  };
}

// Retain the tested Postgres outbox contract until its source is retired.
export async function insertReceiptEvent(pool, row) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`explore-receipt:${row.eventId}`]);
    await client.query(`INSERT INTO analytics_events(event, distinct_id, properties, source, service, ts)
      SELECT $1,$2,$3::jsonb,'server','auth-service',$4 WHERE NOT EXISTS (SELECT 1 FROM analytics_events
        WHERE source = 'server' AND service = 'auth-service' AND event = $1 AND properties->>'_delivery_id' = $5)`,
    [row.event,String(row.userId),JSON.stringify({...row.properties,_delivery_id:row.eventId}),row.createdAt,row.eventId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { broken = true; });
    throw error;
  } finally { client.release(broken); }
}
