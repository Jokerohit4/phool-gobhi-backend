import { randomUUID } from 'node:crypto';
import { customers } from './audience.js';
import { sendPush } from './push.js';
import { completeDrainedCampaigns, pageSize, pool, queueScheduled, saveAudiencePage } from './store.js';

async function expandOne() {
  const { rows: [run] } = await pool.query(`
    SELECT r.* FROM notification.run r JOIN notification.campaign c ON c.id = r.campaign_id
    WHERE NOT r.expanded AND r.due_at <= now() AND c.status IN ('active', 'completed')
    ORDER BY r.due_at LIMIT 1
  `);
  if (!run) return false;
  const recipients = await customers({ audience: run.config.audience, after: run.cursor, limit: pageSize });
  await saveAudiencePage(run, recipients.map(user => user.id));
  return true;
}

async function deliverBatch() {
  const { rows: [run] } = await pool.query(`
    SELECT r.* FROM notification.run r JOIN notification.campaign c ON c.id = r.campaign_id
    WHERE r.due_at <= now() AND (r.kind = 'test' OR c.status IN ('active', 'completed'))
      AND EXISTS (SELECT 1 FROM notification.delivery d WHERE d.run_id = r.id AND d.status = 'queued')
    ORDER BY r.due_at LIMIT 1
  `);
  if (!run) return false;
  const { rows: candidates } = await pool.query(`
    SELECT user_id FROM notification.delivery WHERE run_id = $1 AND status = 'queued' ORDER BY user_id LIMIT 25
  `, [run.id]);
  const ids = candidates.map(row => row.user_id);
  const users = await customers({ ids, includeTokens: true });
  const profiles = new Map(users.map(user => [user.id, user]));
  const { rows } = await pool.query(`
    WITH eligible AS (
      SELECT id FROM notification.campaign
      WHERE id = $2 AND ($4 = 'test' OR status IN ('active', 'completed')) FOR SHARE
    )
    UPDATE notification.delivery d SET status = 'sending', updated_at = now()
    WHERE d.run_id = $1 AND d.user_id = ANY($3) AND d.status = 'queued'
      AND EXISTS (SELECT 1 FROM eligible)
    RETURNING d.user_id
  `, [run.id, run.campaign_id, ids, run.kind]);
  const outcomes = await Promise.all(rows.map(async ({ user_id: userId }) => {
    const user = profiles.get(userId);
    const audience = run.config.audience;
    const inCohort = run.kind === 'test' || audience.type !== 'cohorts' || audience.cohorts.includes(user?.accountCohort);
    let status = 'skipped';
    let code = 'no-active-token';
    if (user?.fcmToken && inCohort) {
      try {
        await sendPush(run, userId, user.fcmToken);
        status = 'accepted';
        code = null;
      } catch (error) {
        code = error.code ?? 'push-error';
        status = ['messaging/internal-error', 'messaging/server-unavailable', 'app/network-error'].includes(code) ? 'unknown' : 'failed';
      }
    }
    return { userId, status, code };
  }));
  if (outcomes.length) {
    await pool.query(`
      UPDATE notification.delivery d SET status = outcome.status, error_code = outcome.code, updated_at = now()
      FROM unnest($2::integer[], $3::text[], $4::text[]) AS outcome(user_id, status, code)
      WHERE d.run_id = $1 AND d.user_id = outcome.user_id AND d.status = 'sending'
    `, [run.id, outcomes.map(row => row.userId), outcomes.map(row => row.status), outcomes.map(row => row.code)]);
  }
  return rows.length > 0;
}

export async function tick() {
  const holder = randomUUID();
  const { rowCount } = await pool.query(`
    INSERT INTO notification.worker_lease AS lease (name, holder, expires_at)
    VALUES ('delivery', $1, now() + INTERVAL '2 minutes')
    ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
    WHERE lease.expires_at <= now()
  `, [holder]);
  if (!rowCount) return { busy: true };
  try {
    const now = new Date();
    await pool.query(`
      UPDATE notification.delivery SET status = 'unknown', error_code = 'worker-interrupted', updated_at = now()
      WHERE status = 'sending' AND updated_at < now() - INTERVAL '15 minutes'
    `);
    await pool.query(`
      DELETE FROM notification.event_receipt
      WHERE ctid IN (
        SELECT ctid FROM notification.event_receipt
        WHERE received_at < now() - INTERVAL '30 days' LIMIT 5000
      )
    `);
    const scheduled = await queueScheduled(now);
    const deadline = Date.now() + 35000;
    let batches = 0;
    while (Date.now() < deadline) {
      const sent = await deliverBatch();
      const expanded = await expandOne();
      if (!sent && !expanded) break;
      batches++;
    }
    await completeDrainedCampaigns();
    return { scheduled, batches };
  } finally {
    await pool.query("DELETE FROM notification.worker_lease WHERE name = 'delivery' AND holder = $1", [holder]);
  }
}
