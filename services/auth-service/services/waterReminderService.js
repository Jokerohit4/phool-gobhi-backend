import { randomUUID } from 'node:crypto';

// Daily 08:00 IST "drink water" push to every active customer that has a push
// token. Triggered by a Cloud Scheduler job (POST /internal/water-reminder/run).
//
// Enabled in prod through WATER_REMINDER_ENABLED in deploy/services.json; the
// Cloud Scheduler job water-reminder-prod fires it at 08:00 Asia/Kolkata.
//
// Safety rails (this goes to live users and cannot be unsent):
//  * Off unless WATER_REMINDER_ENABLED === 'true'. A dry run (`dryRun: true`)
//    works either way, counts the recipients and sends nothing.
//  * A real send only happens inside the IST send window (07:00-10:00), so a
//    stray or replayed call at any other time does nothing.
//  * At most one real send per IST calendar day per instance (the scheduler is
//    configured with no retries, so this is a second line of defence).
//  * No personal data in logs: only counts and FCM error codes.
//
// Not in this version: a per-user opt-out (users can turn notifications off in
// the phone's settings), localisation, or telemetry events (the push telemetry
// work ships with the next dev->main release).

export const WATER_REMINDER_TYPE = 'water_reminder';
export const WATER_REMINDER_TITLE = 'Good morning \u{1F4A7}';
export const WATER_REMINDER_BODY = 'Start your day with a glass of water.';
export const SEND_WINDOW_START_HOUR_IST = 7;
export const SEND_WINDOW_END_HOUR_IST = 10; // exclusive
const PAGE_SIZE = 250; // also keeps each FCM batch well under the 500 limit
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

let lastSentIstDate = null;

export function istParts(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return { date: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

export function resetWaterReminderStateForTests() {
  lastSentIstDate = null;
}

export function buildWaterReminderMessage(token, { nowMs = Date.now(), id = randomUUID() } = {}) {
  return {
    token,
    notification: { title: WATER_REMINDER_TITLE, body: WATER_REMINDER_BODY },
    // push_type / notification_id / sent_at let the apps' receipt tracking count
    // opens (it ignores pushes without a notification_id).
    data: {
      type: WATER_REMINDER_TYPE,
      push_type: WATER_REMINDER_TYPE,
      notification_id: id,
      sent_at: String(nowMs),
    },
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { 'mutable-content': 1, sound: 'default' } },
    },
  };
}

async function defaultDeps() {
  const [{ default: prisma }, { sendEachPush }] = await Promise.all([
    import('../db/prisma.js'),
    import('../utils/notifyUser.js'),
  ]);
  return {
    findPage: (afterId) =>
      prisma.user.findMany({
        where: {
          role: 'customer',
          isActive: true,
          archivedAt: null,
          fcmToken: { not: '' },
          id: { gt: afterId },
        },
        select: { id: true, fcmToken: true },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
      }),
    sendEach: sendEachPush,
  };
}

export async function runWaterReminderService({ dryRun = false, now = new Date(), env = process.env, deps } = {}) {
  const { date, hour } = istParts(now);
  const enabled = env.WATER_REMINDER_ENABLED === 'true';

  if (!dryRun) {
    if (!enabled) return { skipped: 'disabled', istDate: date };
    if (hour < SEND_WINDOW_START_HOUR_IST || hour >= SEND_WINDOW_END_HOUR_IST) {
      return { skipped: 'outside_window', istDate: date, istHour: hour };
    }
    if (lastSentIstDate === date) return { skipped: 'already_sent_today', istDate: date };
    lastSentIstDate = date; // claim the day before sending so a concurrent call cannot double-send
  }

  const d = deps ?? (await defaultDeps());
  let cursor = 0;
  let recipients = 0;
  let sent = 0;
  let failed = 0;
  const failures = {};
  let fcmUnavailable = false;

  for (;;) {
    const page = await d.findPage(cursor);
    if (!page.length) break;
    cursor = page[page.length - 1].id;
    recipients += page.length;
    if (dryRun) continue;

    const nowMs = now.getTime();
    const results = await d.sendEach(page.map((u) => buildWaterReminderMessage(u.fcmToken, { nowMs })));
    if (results === null) {
      fcmUnavailable = true;
      failed += page.length;
      failures.fcm_unavailable = (failures.fcm_unavailable ?? 0) + page.length;
      break;
    }
    for (const r of results) {
      if (r?.success) {
        sent += 1;
      } else {
        failed += 1;
        const code = r?.error?.code || 'unknown';
        failures[code] = (failures[code] ?? 0) + 1;
      }
    }
  }

  if (!dryRun && fcmUnavailable && sent === 0) lastSentIstDate = null; // nothing went out: allow a retry today
  const summary = dryRun
    ? { dryRun: true, recipients, istDate: date }
    : { dryRun: false, recipients, sent, failed, failures, istDate: date };
  console.log('[water-reminder]', JSON.stringify(summary));
  return summary;
}
