// Daily 08:00 IST water reminder (POST /internal/water-reminder/run).
// Run with: node --experimental-test-module-mocks --test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWaterReminderService,
  buildWaterReminderMessage,
  istParts,
  resetWaterReminderStateForTests,
  WATER_REMINDER_TITLE,
  WATER_REMINDER_BODY,
} from '../services/waterReminderService.js';
import { makeRequireInternalOrScheduler } from '../middleware/requireInternalOrScheduler.js';

// 08:00 IST == 02:30 UTC
const AT_8AM_IST = new Date('2026-11-25T02:30:00Z');
const AT_11AM_IST = new Date('2026-11-25T05:30:00Z');
const NEXT_DAY_8AM_IST = new Date('2026-11-26T02:30:00Z');
const ON = { WATER_REMINDER_ENABLED: 'true' };

function users(n, start = 1) {
  return Array.from({ length: n }, (_, i) => ({ id: start + i, fcmToken: `tok-${start + i}` }));
}

// Fake deps over an in-memory list; findPage honours the id cursor and page size.
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
      if (sendResult) return sendResult(messages);
      return messages.map(() => ({ success: true }));
    },
  };
}

beforeEach(() => resetWaterReminderStateForTests());

test('istParts converts UTC to IST date and hour', () => {
  assert.deepEqual(istParts(AT_8AM_IST), { date: '2026-11-25', hour: 8 });
  assert.deepEqual(istParts(new Date('2026-11-24T20:30:00Z')), { date: '2026-11-25', hour: 2 });
});

test('disabled by default: nothing is queried or sent', async () => {
  const deps = fakeDeps(users(3));
  const out = await runWaterReminderService({ now: AT_8AM_IST, env: {}, deps });
  assert.equal(out.skipped, 'disabled');
  assert.equal(deps.calls.pages, 0);
  assert.equal(deps.calls.sent.length, 0);
});

test('a non-"true" flag value does not enable it', async () => {
  const deps = fakeDeps(users(3));
  const out = await runWaterReminderService({ now: AT_8AM_IST, env: { WATER_REMINDER_ENABLED: '1' }, deps });
  assert.equal(out.skipped, 'disabled');
  assert.equal(deps.calls.sent.length, 0);
});

test('dry run counts recipients across pages and sends nothing, even when disabled and out of window', async () => {
  const deps = fakeDeps(users(600));
  const out = await runWaterReminderService({ dryRun: true, now: AT_11AM_IST, env: {}, deps });
  assert.equal(out.dryRun, true);
  assert.equal(out.recipients, 600);
  assert.equal(deps.calls.pages, 4); // 250 + 250 + 100, then an empty page
  assert.equal(deps.calls.sent.length, 0);
});

test('outside the 07:00-10:00 IST window a real run does nothing', async () => {
  const deps = fakeDeps(users(3));
  const out = await runWaterReminderService({ now: AT_11AM_IST, env: ON, deps });
  assert.equal(out.skipped, 'outside_window');
  assert.equal(out.istHour, 11);
  assert.equal(deps.calls.sent.length, 0);
});

test('08:00 IST: sends the water reminder to every recipient with the right payload', async () => {
  const deps = fakeDeps(users(3));
  const out = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps });
  assert.equal(out.recipients, 3);
  assert.equal(out.sent, 3);
  assert.equal(out.failed, 0);
  assert.equal(deps.calls.sent.length, 3);
  const m = deps.calls.sent[0];
  assert.equal(m.token, 'tok-1');
  assert.deepEqual(m.notification, { title: WATER_REMINDER_TITLE, body: WATER_REMINDER_BODY });
  assert.equal(m.data.type, 'water_reminder');
  assert.equal(m.data.push_type, 'water_reminder');
  assert.match(m.data.notification_id, /^[0-9a-f-]{36}$/);
  assert.equal(m.data.sent_at, String(AT_8AM_IST.getTime()));
  assert.equal(m.android.priority, 'high');
  // every recipient gets its own notification_id
  assert.equal(new Set(deps.calls.sent.map((x) => x.data.notification_id)).size, 3);
});

test('pagination: more than one page is fully sent', async () => {
  const deps = fakeDeps(users(600));
  const out = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps });
  assert.equal(out.recipients, 600);
  assert.equal(out.sent, 600);
  assert.equal(deps.calls.sent.length, 600);
});

test('only one real send per IST day; the next day is allowed again', async () => {
  const deps = fakeDeps(users(2));
  const first = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps });
  assert.equal(first.sent, 2);
  const again = await runWaterReminderService({ now: new Date('2026-11-25T03:00:00Z'), env: ON, deps });
  assert.equal(again.skipped, 'already_sent_today');
  assert.equal(deps.calls.sent.length, 2);
  const nextDay = await runWaterReminderService({ now: NEXT_DAY_8AM_IST, env: ON, deps });
  assert.equal(nextDay.sent, 2);
});

test('a dry run does not consume the day', async () => {
  const deps = fakeDeps(users(2));
  await runWaterReminderService({ dryRun: true, now: AT_8AM_IST, env: ON, deps });
  const real = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps });
  assert.equal(real.sent, 2);
});

test('failures are counted by FCM error code, with no tokens in the summary', async () => {
  const deps = fakeDeps(users(4), {
    sendResult: (messages) =>
      messages.map((_, i) =>
        i === 1
          ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
          : i === 2
            ? { success: false, error: { code: 'messaging/internal-error' } }
            : { success: true },
      ),
  });
  const out = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps });
  assert.equal(out.sent, 2);
  assert.equal(out.failed, 2);
  assert.deepEqual(out.failures, {
    'messaging/registration-token-not-registered': 1,
    'messaging/internal-error': 1,
  });
  assert.ok(!JSON.stringify(out).includes('tok-'));
});

test('FCM unavailable: reported as failed and the day is not consumed, so a retry can run', async () => {
  const bad = fakeDeps(users(3), { sendResult: () => null });
  const out = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps: bad });
  assert.equal(out.sent, 0);
  assert.equal(out.failed, 3);
  assert.equal(out.failures.fcm_unavailable, 3);
  const good = fakeDeps(users(3));
  const retry = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps: good });
  assert.equal(retry.sent, 3);
});

test('no recipients: succeeds with zero and sends nothing', async () => {
  const deps = fakeDeps([]);
  const out = await runWaterReminderService({ now: AT_8AM_IST, env: ON, deps });
  assert.equal(out.recipients, 0);
  assert.equal(deps.calls.sent.length, 0);
});

test('buildWaterReminderMessage is stable and carries receipt keys', () => {
  const m = buildWaterReminderMessage('abc', { nowMs: 123, id: 'id-1' });
  assert.deepEqual(m.data, { type: 'water_reminder', push_type: 'water_reminder', notification_id: 'id-1', sent_at: '123' });
});

// ---- scheduler / internal-key guard ------------------------------------

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
  const r = await run(mw, { authorization: 'Bearer abc' });
  assert.equal(r.allowed, true);
  assert.equal(seenAudience, 'https://svc.example');
});

test('a token for a different service account is rejected (403)', async () => {
  process.env.WATER_REMINDER_SCHEDULER_SA = 'sched@p.iam.gserviceaccount.com';
  process.env.WATER_REMINDER_AUDIENCE = 'https://svc.example';
  process.env.INTERNAL_API_KEY = 'secret';
  const mw = makeRequireInternalOrScheduler({ verify: async () => ({ email: 'someone@else.com', email_verified: true }) });
  const r = await run(mw, { authorization: 'Bearer abc' });
  assert.equal(r.allowed, false);
  assert.equal(r.status, 403);
});

test('an invalid / unverifiable token is rejected (403), and an unverified email is rejected', async () => {
  process.env.WATER_REMINDER_SCHEDULER_SA = 'sched@p.iam.gserviceaccount.com';
  process.env.WATER_REMINDER_AUDIENCE = 'https://svc.example';
  process.env.INTERNAL_API_KEY = 'secret';
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
