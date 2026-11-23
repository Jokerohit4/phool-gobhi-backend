import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePushType, errorCodeOf, sendWithTelemetry, stampPush } from '../utils/pushTelemetry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('push types follow the stable taxonomy', () => {
  assert.equal(derivePushType({ type: 'booking_confirmed' }), 'booking_confirmed');
  assert.equal(derivePushType({ type: 'booking_reminder' }), 'session_reminder');
  assert.equal(derivePushType({ type: 'health_nudge', nudge: 'first_step' }), 'nudge:first_step');
  assert.equal(derivePushType({ type: 'health_nudge', nudge: 'comeback' }), 'nudge:comeback');
  assert.equal(derivePushType({ type: 'notification_campaign' }), 'campaign');
  assert.equal(derivePushType({}), 'unknown');
  assert.equal(derivePushType(undefined), 'unknown');
});

test('stamping adds exactly three string keys and leaves everything else alone', () => {
  const original = { token: 't', notification: { title: 'Hi', body: 'There' }, data: { type: 'buddy_match', matchId: '4' }, android: { priority: 'high' } };
  const { message, meta } = stampPush(original, { now: 1760000000000 });
  assert.match(message.data.notification_id, UUID);
  assert.equal(message.data.push_type, 'buddy_match');
  assert.equal(message.data.sent_at, '1760000000000');
  assert.equal(message.data.type, 'buddy_match');
  assert.equal(message.data.matchId, '4');
  assert.deepEqual(message.notification, original.notification);
  assert.deepEqual(message.android, original.android);
  assert.equal(message.token, 't');
  assert.ok(Object.values(message.data).every(value => typeof value === 'string'));
  assert.deepEqual(Object.keys(original.data), ['type', 'matchId'], 'input is not mutated');
  assert.equal(meta.notificationId, message.data.notification_id);
  assert.notEqual(stampPush(original).meta.notificationId, meta.notificationId);
});

test('a message without data still gets the keys; an explicit pushType wins', () => {
  const { message } = stampPush({ token: 't' }, { pushType: 'campaign' });
  assert.equal(message.data.push_type, 'campaign');
  assert.match(message.data.notification_id, UUID);
});

test('error codes come from code or errorInfo, else unknown', () => {
  assert.equal(errorCodeOf({ code: 'messaging/registration-token-not-registered' }), 'messaging/registration-token-not-registered');
  assert.equal(errorCodeOf({ errorInfo: { code: 'messaging/invalid-argument' } }), 'messaging/invalid-argument');
  assert.equal(errorCodeOf(new Error('x')), 'unknown');
});

test('a successful send returns the FCM id and stamps what it sends', async () => {
  const seen = [];
  const id = await sendWithTelemetry(async (message) => { seen.push(message); return 'projects/p/messages/1'; },
    { token: 't', data: { type: 'gift_ready' } }, { recipientId: 7, recipientRole: 'customer', service: 'wallet-service' });
  assert.equal(id, 'projects/p/messages/1');
  assert.equal(seen[0].data.push_type, 'gift_ready');
  assert.match(seen[0].data.notification_id, UUID);
});

test('a failing send rethrows the original error untouched', async () => {
  const boom = Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
  await assert.rejects(sendWithTelemetry(async () => { throw boom; }, { token: 't', data: { type: 'x' } }, { recipientId: 7 }), (error) => error === boom);
});

test('telemetry does nothing when there is no recipient id and never throws', async () => {
  const id = await sendWithTelemetry(async () => 'ok', { token: 't', data: { type: 'x' } }, {});
  assert.equal(id, 'ok');
});
