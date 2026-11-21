import assert from 'node:assert/strict';
import test from 'node:test';
import { destinations, nextSlot, validateConfig } from '../config.js';
import { pushMessage } from '../push.js';

const draft = {
  name: 'Try the gym', title: 'Your next workout', subtitle: 'See the details',
  imageUrl: 'https://cdn.example.com/fitness.png', deepLink: '/details?gymId=42',
  mode: 'once', audience: { type: 'users', userIds: [1, 1, 2] },
};

test('normalizes recipient IDs and dates while retaining the typed deep link', () => {
  const config = validateConfig({ ...draft, startAt: '2026-11-18T09:15:00+05:30' });
  assert.deepEqual(config.audience.userIds, [1, 2]);
  assert.equal(config.startAt, '2026-11-18T03:45:00.000Z');
  assert.equal(config.deepLink, '/details?gymId=42');
  assert.equal(new Set(destinations.map(item => item.path)).size, destinations.length);
});

test('rejects unsupported, invalid and ambiguous campaign destinations', () => {
  for (const deepLink of [
    'https://example.com/details?gymId=1', '//example.com', '/details',
    '/details?gymId=0', '/details?gymId=1&gymId=2', '/details?gymId=2147483648',
    '/details?gymId=1#', '/main?', '/unknown', '/wallet?gymId=1',
  ]) {
    assert.throws(() => validateConfig({ ...draft, deepLink }), /destination|gymId/i, deepLink);
  }
  assert.throws(() => validateConfig({ ...draft, imageUrl: 'http://example.com/a.png' }), /HTTPS/);
  assert.throws(() => validateConfig({ ...draft, startAt: '2026-11-18T09:15' }), /UTC offset/);
});

test('skips missed recurring slots and observes maximum sends and end time', () => {
  const config = validateConfig({ ...draft, mode: 'recurring', intervalMinutes: 60, maxRuns: 3,
    endAt: '2026-11-18T10:00:00Z' });
  const first = new Date('2026-11-18T07:00:00Z');
  const late = new Date('2026-11-18T08:18:00Z');
  assert.equal(nextSlot(config, first, late, 1)?.toISOString(), '2026-11-18T09:00:00.000Z');
  assert.equal(nextSlot(config, first, late, 3), null);
  assert.equal(nextSlot(config, first, new Date('2026-11-18T10:00:00Z'), 2), null);
});

test('validates event controls and maps dynamic content to both platform payloads', () => {
  const config = validateConfig({ ...draft, mode: 'event', event: 'booking_started', delayMinutes: 5,
    cooldownMinutes: 10, maxPerUser: 2 });
  assert.throws(() => validateConfig({ ...config, cooldownMinutes: 0 }), /Cooldown/);
  assert.throws(() => validateConfig({ ...config, event: 'unknown' }), /supported event/);
  const message = pushMessage({ id: 'run', campaign_id: 'campaign', config }, 42, 'token');
  assert.deepEqual(message.notification, { title: draft.title, body: draft.subtitle });
  assert.equal(message.android.notification.imageUrl, draft.imageUrl);
  assert.equal(message.apns.payload.aps.mutableContent, true);
  assert.equal(message.data.deepLink, draft.deepLink);
  assert.equal(message.data.recipientId, '42');
  assert.ok(Object.values(message.data).every(value => typeof value === 'string'));
});
