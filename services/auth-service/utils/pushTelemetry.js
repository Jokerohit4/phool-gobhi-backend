// Canonical push-notification telemetry. Vendored into the service builds that
// send FCM messages by tools/analytics/sync.mjs; do not edit a service copy
// independently.
//
// Contract (see docs/analytics-bigquery-runbook.md, "Push telemetry"):
//  - every FCM message gets three extra STRING data keys: notification_id (uuid v4,
//    one per recipient token send), push_type, sent_at (epoch ms). Visible
//    notification content and every existing data key are untouched.
//  - after the send settles, a server event is emitted: push_sent (props
//    notification_id, push_type, service, recipient_role?, fcm_message_id?, campaign_id?)
//    or push_failed (notification_id, push_type, service, error_code).
//    distinct_id is the recipient user id. No title/body/content, ever.
//  - telemetry is fire-and-forget: it is detached from the request scope, never
//    awaited, and every fault is swallowed. The send's own result/error is
//    returned/thrown exactly as before.
import { randomUUID } from 'node:crypto';
import { track } from './analytics.js';
import { detachFromRequest } from './analyticsTransport.js';

// Stable taxonomy. Legacy data.type values map to their documented push_type.
const TYPE_ALIASES = { booking_reminder: 'session_reminder', notification_campaign: 'campaign' };

export function derivePushType(data = {}) {
  const type = data?.type;
  if (!type) return 'unknown';
  if (type === 'health_nudge' && data.nudge) return `nudge:${data.nudge}`;
  return TYPE_ALIASES[type] || String(type);
}

export function errorCodeOf(error) {
  const code = error?.code ?? error?.errorInfo?.code ?? 'unknown';
  return String(code).slice(0, 100);
}

export function stampPush(message, { pushType, now = Date.now() } = {}) {
  const meta = {
    notificationId: randomUUID(),
    pushType: String(pushType || derivePushType(message?.data)).slice(0, 100),
    sentAt: now,
  };
  const stamped = {
    ...message,
    data: { ...(message?.data || {}), notification_id: meta.notificationId, push_type: meta.pushType, sent_at: String(meta.sentAt) },
  };
  return { message: stamped, meta };
}

function props(meta, ctx, extra) {
  const out = {
    notification_id: meta.notificationId,
    push_type: meta.pushType,
    service: ctx.service || process.env.ANALYTICS_SERVICE_NAME || 'backend',
    ...extra,
  };
  if (ctx.recipientRole) out.recipient_role = ctx.recipientRole;
  if (ctx.campaignId) out.campaign_id = ctx.campaignId;
  return out;
}

function emitSent(meta, ctx, messageId) {
  try {
    if (ctx.recipientId == null) return;
    detachFromRequest(() => track('push_sent', ctx.recipientId, props(meta, ctx, typeof messageId === 'string' ? { fcm_message_id: messageId.slice(0, 200) } : {})));
  } catch { /* telemetry never affects a push */ }
}

function emitFailed(meta, ctx, error) {
  try {
    if (ctx.recipientId == null) return;
    detachFromRequest(() => track('push_failed', ctx.recipientId, props(meta, ctx, { error_code: errorCodeOf(error) })));
  } catch { /* telemetry never affects a push */ }
}

// send: (message) => Promise<fcmMessageId>. ctx: { recipientId, recipientRole,
// pushType?, service?, campaignId? }. One notification_id per call (per token).
export async function sendWithTelemetry(send, message, ctx = {}) {
  let stamped = message;
  let meta = null;
  try {
    ({ message: stamped, meta } = stampPush(message, ctx));
  } catch {
    stamped = message;
    meta = null;
  }
  let messageId;
  try {
    messageId = await send(stamped);
  } catch (error) {
    if (meta) emitFailed(meta, ctx, error);
    throw error;
  }
  if (meta) emitSent(meta, ctx, messageId);
  return messageId;
}
