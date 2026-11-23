import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Every booking-service FCM send is stamped with notification_id / push_type /
// sent_at, keeps its visible content and existing data keys, and the push
// result/errors behave exactly as before.
const sent = [];
let failNext = null;
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
mock.module('firebase-admin', {
  defaultExport: {
    apps: [{}],
    messaging: () => ({
      send: async (message) => {
        if (failNext) { const error = failNext; failNext = null; throw error; }
        sent.push(message);
        return 'projects/p/messages/1';
      },
    }),
  },
});
mock.module('axios', {
  defaultExport: {
    get: async (url) => (url.includes('/internal/9')
      ? { data: { data: { partnerId: 77, name: 'Iron Gym' } } }
      : { data: { fcmToken: 'tok', data: { fcmToken: 'tok' } } }),
  },
});
mock.module('../utils/axiosDefaults.js', { namedExports: {} });
mock.module('../utils/googleIdToken.js', { namedExports: { googleIdTokenHeader: async () => ({}) } });

const { notifyCustomer } = await import('../utils/notifyCustomer.js');
const { notifyPartner, sendPartnerPush } = await import('../utils/notifyPartner.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('notifyCustomer stamps the push and keeps content and routing keys', async () => {
  sent.length = 0;
  await notifyCustomer(5, { title: 'Booking confirmed', body: 'Body', data: { type: 'booking_confirmed', bookingId: 3, date: '2026-11-24' } });
  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.deepEqual(message.notification, { title: 'Booking confirmed', body: 'Body' });
  assert.equal(message.data.type, 'booking_confirmed');
  assert.equal(message.data.bookingId, '3');
  assert.equal(message.data.push_type, 'booking_confirmed');
  assert.match(message.data.notification_id, UUID);
  assert.match(message.data.sent_at, /^\d{13}$/);
  assert.equal(message.android.notification.channelId, 'bookings_channel');
});

test('reminders map to the session_reminder push type', async () => {
  sent.length = 0;
  await notifyCustomer(5, { title: 'T', body: 'B', data: { type: 'booking_reminder', bookingId: 3 } });
  assert.equal(sent[0].data.push_type, 'session_reminder');
});

test('partner pushes are stamped too, including the daily briefing', async () => {
  sent.length = 0;
  await notifyPartner(9, { id: 1, date: '2026-11-24', startTime: '10:00', endTime: '11:00', amount: 100 });
  assert.equal(await sendPartnerPush(9, 'Your gym yesterday', 'Body', { type: 'daily_briefing' }), true);
  assert.deepEqual(sent.map((m) => m.data.push_type), ['new_booking', 'daily_briefing']);
  assert.ok(sent.every((m) => UUID.test(m.data.notification_id)));
  assert.notEqual(sent[0].data.notification_id, sent[1].data.notification_id);
  assert.equal(sent[0].data.gymName, 'Iron Gym');
});

test('a failed FCM send is still swallowed by the notifier (existing behaviour)', async () => {
  sent.length = 0;
  failNext = Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
  await notifyCustomer(5, { title: 'T', body: 'B', data: { type: 'booking_cancelled' } });
  assert.equal(sent.length, 0);
  failNext = Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
  assert.equal(await sendPartnerPush(9, 'T', 'B', { type: 'daily_briefing' }), false);
});
