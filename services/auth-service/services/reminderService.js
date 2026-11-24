import { randomUUID } from 'node:crypto';
import { SLOTS, findDueSlot, findSlotByTime, buildSlotMessage } from './reminderSchedule.js';

// Daily water / meal / workout reminder pushes (see reminderSchedule.js for the
// slots and copy). Triggered by Cloud Scheduler hitting POST /internal/reminders/run
// (and the older /internal/water-reminder/run, which runs the same code) at each
// slot time, Asia/Kolkata.
//
// Safety rails (this goes to live users and cannot be unsent):
//  * Three independent kill switches: WATER_REMINDER_ENABLED, MEAL_REMINDERS_ENABLED,
//    WORKOUT_REMINDERS_ENABLED (each must be exactly 'true'). A bundled slot sends
//    only the categories that are on; a slot with nothing on is skipped.
//  * A real send only happens for the slot whose time is within the last 10 minutes,
//    so a stray or replayed call at any other time does nothing.
//  * At most one real send per slot per IST day per instance (the scheduler jobs are
//    configured with no retries, which is the primary guard).
//  * Dry runs (dryRun:true) never send: they count recipients and return the exact
//    messages. `slot: 'all'` previews the whole day; `slot: 'HH:MM'` one slot.
//  * No personal data in logs: only counts and FCM error codes.
//
// Not in this version: a per-user opt-out (users can turn notifications off in the
// phone's settings), localisation, skipping users who already did the thing, or
// telemetry events (the push telemetry work ships with the next dev->main release).

const PAGE_SIZE = 250; // also keeps each FCM batch well under the 500 limit
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const sentSlots = new Set();

export function istDate(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function resetReminderStateForTests() {
  sentSlots.clear();
}

export function enabledCategories(env = process.env) {
  return {
    water: env.WATER_REMINDER_ENABLED === 'true',
    meal: env.MEAL_REMINDERS_ENABLED === 'true',
    workout: env.WORKOUT_REMINDERS_ENABLED === 'true',
  };
}

export function buildReminderMessage(token, message, { nowMs = Date.now(), id = randomUUID() } = {}) {
  return {
    token,
    notification: { title: message.title, body: message.body },
    // push_type / notification_id / sent_at let the apps' receipt tracking count
    // opens (it ignores pushes without a notification_id).
    data: { ...message.data, push_type: message.pushType, notification_id: id, sent_at: String(nowMs) },
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

async function countRecipients(d) {
  let cursor = 0;
  let total = 0;
  for (;;) {
    const page = await d.findPage(cursor);
    if (!page.length) return total;
    cursor = page[page.length - 1].id;
    total += page.length;
  }
}

function preview(slot, enabled) {
  const message = buildSlotMessage(slot, enabled);
  return {
    time: slot.time,
    enabled: Boolean(message),
    ...(message ? { type: message.pushType, title: message.title, body: message.body, data: message.data } : {}),
  };
}

export async function runReminderService({ dryRun = false, slot: slotParam, now = new Date(), env = process.env, deps } = {}) {
  const date = istDate(now);
  const enabled = enabledCategories(env);

  if (dryRun) {
    const d = deps ?? (await defaultDeps());
    let slots;
    if (slotParam === 'all') slots = SLOTS;
    else if (slotParam) {
      const s = findSlotByTime(slotParam);
      slots = s ? [s] : [];
    } else {
      const due = findDueSlot(now);
      slots = due ? [due] : [];
    }
    const summary = {
      dryRun: true,
      istDate: date,
      recipients: await countRecipients(d),
      enabled,
      slots: slots.map((s) => preview(s, enabled)),
    };
    console.log('[reminders]', JSON.stringify({ dryRun: true, recipients: summary.recipients, slots: summary.slots.map((s) => s.time) }));
    return summary;
  }

  const slot = findDueSlot(now);
  if (!slot) return { skipped: 'no_slot_due', istDate: date };
  const message = buildSlotMessage(slot, enabled);
  if (!message) return { skipped: 'disabled', slot: slot.time, istDate: date };
  const key = `${date}|${slot.time}`;
  if (sentSlots.has(key)) return { skipped: 'already_sent', slot: slot.time, istDate: date };
  sentSlots.add(key); // claim the slot before sending so a concurrent call cannot double-send

  const d = deps ?? (await defaultDeps());
  let cursor = 0;
  let recipients = 0;
  let sent = 0;
  let failed = 0;
  const failures = {};
  let fcmUnavailable = false;
  const nowMs = now.getTime();

  for (;;) {
    const page = await d.findPage(cursor);
    if (!page.length) break;
    cursor = page[page.length - 1].id;
    recipients += page.length;
    const results = await d.sendEach(page.map((u) => buildReminderMessage(u.fcmToken, message, { nowMs })));
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

  if (fcmUnavailable && sent === 0) sentSlots.delete(key); // nothing went out: allow a retry
  const summary = { dryRun: false, slot: slot.time, type: message.pushType, recipients, sent, failed, failures, istDate: date };
  console.log('[reminders]', JSON.stringify(summary));
  return summary;
}
