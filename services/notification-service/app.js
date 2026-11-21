import './bootstrap.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { customers } from './audience.js';
import { cohorts, destinations, events, invalid, isUserId, isUuid, validateConfig } from './config.js';
import { addRun, pool, queueEvent, transaction } from './store.js';
import { tick } from './worker.js';

const app = express();
app.use(express.json({ limit: '24kb' }));

function identity(role) {
  return (req, res, next) => {
    const userId = Number(req.get('x-user-id'));
    if (req.get('x-user-role') !== role || !isUserId(userId)) throw invalid('Forbidden', 403);
    req.actorId = userId;
    next();
  };
}

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.post('/events', identity('customer'), async (req, res) => {
  const { event, id } = req.body ?? {};
  if (typeof event !== 'string' || !Object.hasOwn(events, event) || !isUuid(id)) throw invalid('Invalid notification event');
  // Avoid the auth round-trip when there is no matching campaign.
  const { rowCount } = await pool.query(`
    SELECT 1 FROM notification.campaign WHERE status = 'active' AND config->>'event' = $1
      AND COALESCE((config->>'startAt')::timestamptz, '-infinity') <= now()
      AND COALESCE((config->>'endAt')::timestamptz, 'infinity') >= now() LIMIT 1
  `, [event]);
  if (rowCount) {
    const [user] = await customers({ ids: [req.actorId] });
    if (user) await queueEvent(user, event, id);
  }
  res.sendStatus(204);
});

app.use('/admin', identity('gobhi'));
app.get('/admin/options', (_req, res) => res.json({ destinations, events, cohorts }));

app.get('/admin/campaigns', async (req, res) => {
  const before = req.query.before || null;
  if (before && !isUuid(before)) throw invalid('Invalid campaign cursor');
  const { rows } = await pool.query(`
    SELECT * FROM notification.campaign
    WHERE $1::uuid IS NULL OR (created_at, id) < (SELECT created_at, id FROM notification.campaign WHERE id = $1)
    ORDER BY created_at DESC, id DESC LIMIT 51
  `, [before]);
  res.json({ data: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null });
});

app.post('/admin/campaigns', async (req, res) => {
  const config = validateConfig(req.body);
  const { rows: [campaign] } = await pool.query(`
    INSERT INTO notification.campaign (id, config, created_by, updated_by)
    VALUES ($1, $2, $3, $3) RETURNING *
  `, [randomUUID(), config, req.actorId]);
  res.status(201).json({ data: campaign });
});

app.param('id', (req, _res, next, id) => {
  if (!isUuid(id)) throw invalid('Invalid campaign ID');
  next();
});

app.get('/admin/campaigns/:id', async (req, res) => {
  const { rows: [campaign] } = await pool.query('SELECT * FROM notification.campaign WHERE id = $1', [req.params.id]);
  if (!campaign) throw invalid('Campaign not found', 404);
  res.json({ data: campaign });
});

async function discardPending(db, campaignId) {
  await db.query(`
    UPDATE notification.run SET expanded = true WHERE campaign_id = $1 AND NOT expanded
  `, [campaignId]);
  await db.query(`
    UPDATE notification.delivery d SET status = 'skipped', error_code = 'cancelled', updated_at = now()
    FROM notification.run r
    WHERE d.run_id = r.id AND r.campaign_id = $1 AND r.kind != 'test' AND d.status = 'queued'
  `, [campaignId]);
}

app.put('/admin/campaigns/:id', async (req, res) => {
  const config = validateConfig(req.body);
  const data = await transaction(pool, async db => {
    const { rows: [campaign] } = await db.query(`
      UPDATE notification.campaign SET config = $2, next_at = NULL, run_count = CASE WHEN config->>'mode' = $4 THEN run_count ELSE 0 END, updated_by = $3, updated_at = now()
      WHERE id = $1 AND status IN ('draft','paused')
        AND (config->>'mode' != 'once' OR run_count = 0) RETURNING *
    `, [req.params.id, config, req.actorId, config.mode]);
    if (!campaign) throw invalid('Campaign must be a draft or paused, and a one-time delivery must be pending', 409);
    if (campaign.status === 'paused') await discardPending(db, campaign.id);
    return campaign;
  });
  res.json({ data });
});

app.post('/admin/campaigns/:id/status', async (req, res) => {
  const action = req.body?.action;
  const data = await transaction(pool, async db => {
    const { rows: [campaign] } = await db.query('SELECT * FROM notification.campaign WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!campaign) throw invalid('Campaign not found', 404);
    let next = campaign.next_at;
    let status;
    const { config } = campaign;
    if (action === 'activate' && ['draft', 'paused'].includes(campaign.status)) {
      const now = new Date();
      if (config.endAt && new Date(config.endAt) <= now) throw invalid('Update the campaign end time before activating');
      if (config.mode === 'recurring' && campaign.run_count >= config.maxRuns) throw invalid('Increase the maximum sends before activating');
      if (config.mode !== 'event' && !next && (config.mode !== 'once' || campaign.run_count === 0)) {
        next = config.startAt ? new Date(config.startAt) : now;
      }
      status = 'active';
    } else if (action === 'pause' && campaign.status === 'active') {
      status = 'paused';
    } else if (action === 'cancel' && ['draft', 'active', 'paused'].includes(campaign.status)) {
      status = 'cancelled';
      next = null;
      await discardPending(db, campaign.id);
    } else {
      throw invalid('This campaign cannot perform that action', 409);
    }
    const { rows: [updated] } = await db.query(`
      UPDATE notification.campaign SET status = $2, next_at = $3, updated_by = $4, updated_at = now()
      WHERE id = $1 RETURNING *
    `, [campaign.id, status, next, req.actorId]);
    return updated;
  });
  res.json({ data });
});

app.post('/admin/campaigns/:id/test', async (req, res) => {
  const userId = req.body?.userId;
  if (!isUserId(userId)) throw invalid('Enter a valid customer ID');
  const [user] = await customers({ ids: [userId], includeTokens: true });
  if (!user?.fcmToken) throw invalid('This customer has no registered push token');
  const id = await transaction(pool, async db => {
    const { rows: [campaign] } = await db.query('SELECT * FROM notification.campaign WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!campaign) throw invalid('Campaign not found', 404);
    if (campaign.status === 'cancelled') throw invalid('This campaign has been cancelled', 409);
    return addRun(db, campaign, 'test', new Date(), userId);
  });
  res.status(202).json({ id });
});

app.get('/admin/campaigns/:id/runs', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.id, r.kind, r.due_at, r.expanded, COALESCE((
      SELECT jsonb_object_agg(status, count)
      FROM (SELECT status, count(*) FROM notification.delivery WHERE run_id = r.id GROUP BY status) counts
    ), '{}'::jsonb) AS counts
    FROM notification.run r WHERE r.campaign_id = $1 ORDER BY r.due_at DESC LIMIT 25
  `, [req.params.id]);
  res.json({ data: rows });
});

// Cloud Scheduler calls the private Cloud Run URL using IAM. The gateway exposes
// only /admin and /events. Locally, direct callers must provide the internal key.
app.post('/internal/tick', async (req, res) => {
  if (!process.env.K_SERVICE) {
    const expected = Buffer.from((process.env.INTERNAL_API_KEY || '').trim());
    const key = Buffer.from(req.get('x-internal-key') || '');
    if (!expected.length || expected.length !== key.length || !timingSafeEqual(expected, key)) throw invalid('Forbidden', 403);
  }
  res.json(await tick());
});

app.use((err, _req, res, _next) => {
  if (!err.status) console.error('Notification request failed', err.code || err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Notification service unavailable' });
});

if (!process.env.DATABASE_URL || !process.env.INTERNAL_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Notification service requires DATABASE_URL, INTERNAL_API_KEY and FIREBASE_SERVICE_ACCOUNT_JSON');
}
await transaction(pool, async db => {
  await db.query('SELECT pg_advisory_xact_lock(1005011)');
  await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
});
app.listen(process.env.PORT || 5010);
if (!process.env.K_SERVICE) {
  setInterval(() => tick().catch(error => console.error('Notification worker failed', error.code || error.message)), 30000).unref();
}
