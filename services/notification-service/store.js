import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { isUserId, nextSlot } from './config.js';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 });
pool.on('error', error => console.error('Notification database connection failed', error.code || error.message));
const queryTimeout = 10000;

export async function transaction(database, work) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL statement_timeout = ' + queryTimeout);
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function addRun(db, campaign, kind, dueAt, userId) {
  const id = randomUUID();
  await db.query(`
    INSERT INTO notification.run (id, campaign_id, kind, config, due_at, expanded)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [id, campaign.id, kind, campaign.config, dueAt, isUserId(userId)]);
  if (isUserId(userId)) await addRecipients(db, id, [userId]);
  return id;
}

async function addRecipients(db, runId, userIds) {
  await db.query(`
    INSERT INTO notification.delivery (run_id, user_id)
    SELECT $1, unnest($2::integer[]) ON CONFLICT DO NOTHING
  `, [runId, userIds]);
}

export async function queueEvent(user, event, id, now = new Date()) {
  return transaction(pool, async db => {
    const receipt = await db.query(`
      INSERT INTO notification.event_receipt (user_id, id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING RETURNING id
    `, [user.id, id]);
    if (!receipt.rowCount) return 0;
    const { rows } = await db.query(`
      SELECT * FROM notification.campaign
      WHERE status = 'active' AND config->>'event' = $1
        AND COALESCE((config->>'startAt')::timestamptz, '-infinity') <= $2
        AND COALESCE((config->>'endAt')::timestamptz, 'infinity') >= $2
      ORDER BY id FOR SHARE
    `, [event, now]);
    let queued = 0;
    for (const campaign of rows) {
      const { audience, cooldownMinutes, maxPerUser, delayMinutes, endAt } = campaign.config;
      if (audience.type === 'users' && !audience.userIds.includes(user.id)) continue;
      if (audience.type === 'cohorts' && !audience.cohorts.includes(user.accountCohort)) continue;
      const dueAt = new Date(+now + delayMinutes * 60000);
      if (endAt && dueAt > new Date(endAt)) continue;
      const result = await db.query(`
        INSERT INTO notification.event_frequency AS f (campaign_id, user_id, count, latest_at)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (campaign_id, user_id) DO UPDATE SET count = f.count + 1, latest_at = EXCLUDED.latest_at
        WHERE f.count < $4 AND f.latest_at <= EXCLUDED.latest_at - make_interval(mins => $5)
        RETURNING count
      `, [campaign.id, user.id, now, maxPerUser, cooldownMinutes]);
      if (!result.rowCount) continue;
      await addRun(db, campaign, 'event', dueAt, user.id);
      queued++;
    }
    return queued;
  });
}

export async function queueScheduled(now) {
  return transaction(pool, async db => {
    const { rows } = await db.query(`
      SELECT * FROM notification.campaign WHERE status = 'active' AND next_at <= $1
      ORDER BY next_at LIMIT 30 FOR UPDATE SKIP LOCKED
    `, [now]);
    for (const campaign of rows) {
      const expired = campaign.config.endAt && now > new Date(campaign.config.endAt);
      const count = campaign.run_count + (expired ? 0 : 1);
      const next = expired ? null : nextSlot(campaign.config, campaign.next_at, now, count);
      if (!expired) await addRun(db, campaign, 'scheduled', campaign.next_at);
      await db.query(`
        UPDATE notification.campaign SET next_at = $2, run_count = $3 WHERE id = $1
      `, [campaign.id, next, count]);
    }
    return rows.length;
  });
}

export async function completeDrainedCampaigns() {
  await pool.query(`
    UPDATE notification.campaign c SET status = 'completed', updated_at = now()
    WHERE c.status = 'active' AND c.next_at IS NULL
      AND (c.config->>'mode' != 'event' OR (c.config->>'endAt')::timestamptz < now())
      AND NOT EXISTS (
        SELECT 1 FROM notification.run r
        WHERE r.campaign_id = c.id AND r.kind != 'test' AND (NOT r.expanded OR EXISTS (
          SELECT 1 FROM notification.delivery d WHERE d.run_id = r.id AND d.status IN ('queued', 'sending')
        ))
      )
  `);
}

export const pageSize = 250;

export async function saveAudiencePage(run, userIds) {
  return transaction(pool, async db => {
    const result = await db.query(`
      UPDATE notification.run SET cursor = $3, expanded = $4
      WHERE id = $1 AND cursor = $2 AND NOT expanded
    `, [run.id, run.cursor, userIds.at(-1) ?? run.cursor, userIds.length < pageSize]);
    if (result.rowCount) await addRecipients(db, run.id, userIds);
  });
}
