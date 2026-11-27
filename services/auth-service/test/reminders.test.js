// Daily water / meal / workout reminders (POST /internal/reminders/run).
// Run with: node --experimental-test-module-mocks --test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SLOTS, findDueSlot, istMinutes, buildSlotMessage } from '../services/reminderSchedule.js';
import {
  runReminderService,
  buildReminderMessage,
  enabledCategories,
  istDate,
  resetReminderStateForTests,
} from '../services/reminderService.js';
import { makeRequireInternalOrScheduler } from '../middleware/requireInternalOrScheduler.js';

const ALL_ON = { WATER_REMINDER_ENABLED: 'true', MEAL_REMINDERS_ENABLED: 'true', WORKOUT_REMINDERS_ENABLED: 'true' };
const ON = { water: true, meal: true, workout: true };

// IST HH:MM on 2026-11-25 as a UTC Date (IST = UTC + 5:30)
function ist(hhmm, day = '2026-11-25') {
  const [h, m] = hhmm.split(':').map(Number);
  const utc = new Date(`${day}T00:00:00Z`);
  utc.setUTCMinutes(h * 60 + m - 330);
  return utc;
}

function users(n, start = 1) {
  return Array.from({ length: n }, (_, i) => ({ id: start + i, fcmToken: `tok-${start + i}` }));
}

function fakeDeps(all, { sendResult } = {}) {
  const calls = { pages: 0, sent: [] };
  return {
    calls,
    findPage: async (afterId) => {
      calls.pages += 1;
      return all.filter((u) => u.id > afterId).slice(0, 250);
    },
    sendEach: async (messages) => {
      calls.sent.push(...messages);
      return sendResult ? sendResult(messages) : messages.map(() => ({ success: true }));
    },
  };
}

beforeEach(() => resetReminderStateForTests());

// ---- schedule ----------------------------------------------------------

test('the day has exactly the 10 slots, in order', () => {
  assert.deepEqual(SLOTS.map((s) => s.time), [
    '07:00', '08:00', '10:00', '11:30', '14:00', '15:30', '17:30', '18:00', '19:30', '21:30',
  ]);
});

test('water is four pushes a day (half of the old eight): 08:00, 11:30, 15:30, 19:30', () => {
  assert.deepEqual(SLOTS.filter((s) => s.water).map((s) => s.time), ['08:00', '11:30', '15:30', '19:30']);
});

test('no water push is within an hour of a meal push (either side)', () => {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const meals = SLOTS.filter((s) => s.meal).map((s) => toMin(s.time));
  for (const water of SLOTS.filter((s) => s.water).map((s) => toMin(s.time))) {
    for (const meal of meals) assert.ok(Math.abs(water - meal) > 60, `water at ${water} is within an hour of meal at ${meal}`);
  }
});

test('meals: breakfast 10:00, lunch 14:00, snack 18:00, dinner 21:30; workouts 07:00 and 17:30', () => {
  const at = (meal) => SLOTS.find((s) => s.meal === meal)?.time;
  assert.equal(at('breakfast'), '10:00');
  assert.equal(at('lunch'), '14:00');
  assert.equal(at('snack'), '18:00');
  assert.equal(at('dinner'), '21:30');
  assert.deepEqual(SLOTS.filter((s) => s.workout).map((s) => s.time), ['07:00', '17:30']);
});

test('IST conversion and due-slot window (10 minutes)', () => {
  assert.equal(istMinutes(new Date('2026-11-25T02:30:00Z')), 8 * 60);
  assert.equal(istDate(new Date('2026-11-24T20:30:00Z')), '2026-11-25');
  assert.equal(findDueSlot(ist('07:00'))?.time, '07:00');
  assert.equal(findDueSlot(ist('07:09'))?.time, '07:00');
  assert.equal(findDueSlot(ist('07:10')), null);
  assert.equal(findDueSlot(ist('06:59')), null);
  assert.equal(findDueSlot(ist('11:30'))?.time, '11:30');
  assert.equal(findDueSlot(ist('17:30'))?.time, '17:30');
  assert.equal(findDueSlot(ist('21:30'))?.time, '21:30');
  assert.equal(findDueSlot(ist('22:00')), null);
  assert.equal(findDueSlot(ist('23:00')), null);
  assert.equal(findDueSlot(ist('09:00')), null);
});

// ---- copy and categories -----------------------------------------------

test('copy per slot with everything on', () => {
  const m = (t) => buildSlotMessage(SLOTS.find((s) => s.time === t), ON);
  assert.equal(m('07:00').pushType, 'workout_reminder');
  assert.equal(m('08:00').title, 'Good morning \u{1F4A7}');
  assert.equal(m('08:00').body, 'Start your day with a glass of water.');
  assert.equal(m('08:00').data.type, 'water_reminder');
  // meal pushes are plain: no water line any more
  for (const [t, meal] of [['10:00', 'breakfast'], ['14:00', 'lunch'], ['18:00', 'snack'], ['21:30', 'dinner']]) {
    const x = m(t);
    assert.equal(x.pushType, `meal_reminder:${meal}`);
    assert.doesNotMatch(x.body, /water/);
    assert.deepEqual(x.data, { type: 'health_nudge', route: 'quick_log' });
  }
  assert.equal(m('11:30').title, 'Water break \u{1F4A7}');
  assert.equal(m('15:30').title, 'Water break \u{1F4A7}');
  assert.equal(m('19:30').title, 'Water break \u{1F4A7}');
  assert.equal(m('17:30').pushType, 'workout_reminder');
  assert.equal(m('17:30').data.type, 'workout_reminder');
});

test('category switches: a meal slot degrades to nothing when meal reminders are off, and water still works', () => {
  const ten = SLOTS.find((s) => s.time === '10:00');
  assert.equal(buildSlotMessage(ten, { water: true, meal: false, workout: true }), null);
  assert.equal(buildSlotMessage(ten, { water: false, meal: true, workout: true }).pushType, 'meal_reminder:breakfast');
  assert.equal(buildSlotMessage(SLOTS.find((s) => s.time === '11:30'), { water: true, meal: false, workout: true }).pushType, 'water_reminder');
  assert.equal(buildSlotMessage(SLOTS.find((s) => s.time === '11:30'), { water: false, meal: true, workout: true }), null);
  assert.equal(buildSlotMessage(SLOTS.find((s) => s.time === '17:30'), { water: true, meal: true, workout: false }), null);
  assert.equal(buildSlotMessage(SLOTS.find((s) => s.time === '21:30'), { water: true, meal: false, workout: true }), null);
});

test('only the exact string "true" enables a category', () => {
  assert.deepEqual(enabledCategories({ WATER_REMINDER_ENABLED: '1', MEAL_REMINDERS_ENABLED: 'TRUE', WORKOUT_REMINDERS_ENABLED: 'true' }), {
    water: false, meal: false, workout: true,
  });
});

// ---- service: dry runs ---------------------------------------------------

test('dry run "all" previews all 10 slots and counts recipients without sending, even when disabled', async () => {
  const deps = fakeDeps(users(600));
  const out = await runReminderService({ dryRun: true, slot: 'all', now: ist('03:00'), env: {}, deps });
  assert.equal(out.dryRun, true);
  assert.equal(out.recipients, 600);
  assert.equal(out.slots.length, 10);
  assert.ok(out.slots.every((s) => s.enabled === false)); // everything off in this env
  assert.equal(deps.calls.sent.length, 0);
  const onOut = await runReminderService({ dryRun: true, slot: 'all', now: ist('03:00'), env: ALL_ON, deps });
  assert.ok(onOut.slots.every((s) => s.enabled && s.title && s.body && s.type));
});

test('dry run for one slot and for the currently due slot', async () => {
  const deps = fakeDeps(users(3));
  const one = await runReminderService({ dryRun: true, slot: '14:00', now: ist('03:00'), env: ALL_ON, deps });
  assert.equal(one.slots.length, 1);
  assert.equal(one.slots[0].type, 'meal_reminder:lunch');
  const due = await runReminderService({ dryRun: true, now: ist('17:30'), env: ALL_ON, deps });
  assert.equal(due.slots[0].time, '17:30');
  const none = await runReminderService({ dryRun: true, now: ist('09:00'), env: ALL_ON, deps });
  assert.deepEqual(none.slots, []);
  assert.equal(deps.calls.sent.length, 0);
});

// ---- service: real sends -------------------------------------------------

test('no slot due: nothing is queried or sent', async () => {
  const deps = fakeDeps(users(3));
  const out = await runReminderService({ now: ist('09:00'), env: ALL_ON, deps });
  assert.equal(out.skipped, 'no_slot_due');
  assert.equal(deps.calls.pages, 0);
});

test('all categories off: the slot is skipped as disabled', async () => {
  const deps = fakeDeps(users(3));
  const out = await runReminderService({ now: ist('08:00'), env: {}, deps });
  assert.equal(out.skipped, 'disabled');
  assert.equal(deps.calls.sent.length, 0);
});

test('10:00 sends ONE breakfast push per recipient with receipt keys', async () => {
  const deps = fakeDeps(users(3));
  const now = ist('10:00');
  const out = await runReminderService({ now, env: ALL_ON, deps });
  assert.equal(out.slot, '10:00');
  assert.equal(out.type, 'meal_reminder:breakfast');
  assert.equal(out.sent, 3);
  assert.equal(deps.calls.sent.length, 3); // one message each, not two
  const m = deps.calls.sent[0];
  assert.equal(m.notification.title, 'Breakfast time \u{1F373}');
  assert.equal(m.data.type, 'health_nudge');
  assert.equal(m.data.route, 'quick_log');
  assert.equal(m.data.push_type, 'meal_reminder:breakfast');
  assert.match(m.data.notification_id, /^[0-9a-f-]{36}$/);
  assert.equal(m.data.sent_at, String(now.getTime()));
  assert.equal(new Set(deps.calls.sent.map((x) => x.data.notification_id)).size, 3);
});

test('each slot sends at most once per IST day; other slots and the next day still send', async () => {
  const deps = fakeDeps(users(2));
  assert.equal((await runReminderService({ now: ist('08:00'), env: ALL_ON, deps })).sent, 2);
  assert.equal((await runReminderService({ now: ist('08:03'), env: ALL_ON, deps })).skipped, 'already_sent');
  assert.equal((await runReminderService({ now: ist('10:00'), env: ALL_ON, deps })).sent, 2); // a different slot
  assert.equal((await runReminderService({ now: ist('08:00', '2026-11-26'), env: ALL_ON, deps })).sent, 2); // next day
  assert.equal(deps.calls.sent.length, 6);
});

test('a dry run does not consume the slot', async () => {
  const deps = fakeDeps(users(2));
  await runReminderService({ dryRun: true, now: ist('08:00'), env: ALL_ON, deps });
  assert.equal((await runReminderService({ now: ist('08:00'), env: ALL_ON, deps })).sent, 2);
});

test('pagination: more than one page is fully sent', async () => {
  const deps = fakeDeps(users(600));
  const out = await runReminderService({ now: ist('11:30'), env: ALL_ON, deps });
  assert.equal(out.recipients, 600);
  assert.equal(out.sent, 600);
});

test('failures are counted by FCM error code, with no tokens in the summary', async () => {
  const deps = fakeDeps(users(4), {
    sendResult: (messages) =>
      messages.map((_, i) =>
        i === 1 ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true },
      ),
  });
  const out = await runReminderService({ now: ist('15:30'), env: ALL_ON, deps });
  assert.equal(out.sent, 3);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.failures, { 'messaging/registration-token-not-registered': 1 });
  assert.ok(!JSON.stringify(out).includes('tok-'));
});

test('a token FCM says is dead is cleared; other failures are not; a cleanup error never fails the run', async () => {
  const cleared = [];
  const deps = fakeDeps(users(4), {
    sendResult: (messages) =>
      messages.map((_, i) =>
        i === 1 ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        : i === 2 ? { success: false, error: { code: 'messaging/internal-error' } }
        : i === 3 ? { success: false, error: { code: 'messaging/invalid-registration-token' } }
        : { success: true },
      ),
  });
  deps.clearTokens = async (pairs) => { cleared.push(...pairs); return pairs.length; };
  const out = await runReminderService({ now: ist('11:30'), env: ALL_ON, deps });
  assert.equal(out.sent, 1);
  assert.equal(out.failed, 3);
  assert.deepEqual(cleared, [{ id: 2, token: 'tok-2' }, { id: 4, token: 'tok-4' }]); // not the internal-error one
  assert.equal(out.tokensCleared, 2);
  assert.ok(!JSON.stringify(out).includes('tok-'));
  resetReminderStateForTests();
  const failing = fakeDeps(users(2), { sendResult: (m) => m.map(() => ({ success: false, error: { code: 'messaging/registration-token-not-registered' } })) });
  failing.clearTokens = async () => { throw new Error('db down'); };
  const out2 = await runReminderService({ now: ist('11:30'), env: ALL_ON, deps: failing });
  assert.equal(out2.failed, 2);
  assert.equal(out2.tokensCleared, 0);
  resetReminderStateForTests();
  const clean = fakeDeps(users(2));
  let called = false;
  clean.clearTokens = async () => { called = true; return 0; };
  await runReminderService({ now: ist('11:30'), env: ALL_ON, deps: clean });
  assert.equal(called, false);
});

test('FCM unavailable is reported as failed and the slot stays retryable', async () => {
  const bad = fakeDeps(users(3), { sendResult: () => null });
  const out = await runReminderService({ now: ist('19:30'), env: ALL_ON, deps: bad });
  assert.equal(out.sent, 0);
  assert.equal(out.failures.fcm_unavailable, 3);
  const retry = await runReminderService({ now: ist('19:35'), env: ALL_ON, deps: fakeDeps(users(3)) });
  assert.equal(retry.sent, 3);
});

test('buildReminderMessage keeps the slot data and adds the receipt keys', () => {
  const m = buildReminderMessage('abc', { title: 't', body: 'b', data: { type: 'water_reminder' }, pushType: 'water_reminder' }, { nowMs: 5, id: 'id-1' });
  assert.deepEqual(m.data, { type: 'water_reminder', push_type: 'water_reminder', notification_id: 'id-1', sent_at: '5' });
});

// ---- scheduler / internal-key guard (unchanged behaviour) ----------------

function run(mw, headers) {
  return new Promise((resolve) => {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { resolve({ allowed: false, status: res.statusCode, body: b }); return res; };
    mw({ headers }, res, () => resolve({ allowed: true }));
  });
}

test('scheduler token with the expected service account is allowed', async () => {
  process.env.WATER_REMINDER_SCHEDULER_SA = 'sched@p.iam.gserviceaccount.com';
  process.env.WATER_REMINDER_AUDIENCE = 'https://svc.example';
  process.env.INTERNAL_API_KEY = 'secret';
  let seenAudience;
  const mw = makeRequireInternalOrScheduler({
    verify: async (_t, audience) => { seenAudience = audience; return { email: 'sched@p.iam.gserviceaccount.com', email_verified: true }; },
  });
  assert.equal((await run(mw, { authorization: 'Bearer abc' })).allowed, true);
  assert.equal(seenAudience, 'https://svc.example');
});

test('a token for a different account, an unverifiable token, or an unverified email is rejected (403)', async () => {
  process.env.WATER_REMINDER_SCHEDULER_SA = 'sched@p.iam.gserviceaccount.com';
  process.env.WATER_REMINDER_AUDIENCE = 'https://svc.example';
  process.env.INTERNAL_API_KEY = 'secret';
  const other = makeRequireInternalOrScheduler({ verify: async () => ({ email: 'someone@else.com', email_verified: true }) });
  assert.equal((await run(other, { authorization: 'Bearer abc' })).status, 403);
  const throwing = makeRequireInternalOrScheduler({ verify: async () => { throw new Error('bad sig'); } });
  assert.equal((await run(throwing, { authorization: 'Bearer abc' })).status, 403);
  const unverified = makeRequireInternalOrScheduler({ verify: async () => ({ email: 'sched@p.iam.gserviceaccount.com', email_verified: false }) });
  assert.equal((await run(unverified, { authorization: 'Bearer abc' })).status, 403);
});

test('without scheduler config the guard behaves exactly like requireInternal', async () => {
  delete process.env.WATER_REMINDER_SCHEDULER_SA;
  delete process.env.WATER_REMINDER_AUDIENCE;
  process.env.INTERNAL_API_KEY = 'secret';
  const mw = makeRequireInternalOrScheduler({ verify: async () => ({ email: 'x', email_verified: true }) });
  assert.equal((await run(mw, { authorization: 'Bearer abc' })).status, 403);
  assert.equal((await run(mw, { 'x-internal-key': 'wrong' })).status, 403);
  assert.equal((await run(mw, { 'x-internal-key': 'secret' })).allowed, true);
});
