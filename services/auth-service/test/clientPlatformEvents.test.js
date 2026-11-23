// signup_completed / login_completed carry `platform` and `app_version` only
// when the (client-supplied) x-app-platform / x-app-version headers are valid.
// Run with: node --experimental-test-module-mocks --test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { clientAnalyticsProps } from '../utils/clientContext.js';

test('clientAnalyticsProps accepts only the allow-listed platform and a plain version', () => {
  assert.deepEqual(clientAnalyticsProps({ 'x-app-platform': 'ios', 'x-app-version': '1.4.12' }), { platform: 'ios', app_version: '1.4.12' });
  assert.deepEqual(clientAnalyticsProps({ 'x-app-platform': 'Android', 'x-app-version': ' 2.0 ' }), { platform: 'android', app_version: '2.0' });
  assert.deepEqual(clientAnalyticsProps({ 'x-app-platform': 'web' }), { platform: 'web' });
});

test('clientAnalyticsProps drops anything else', () => {
  assert.deepEqual(clientAnalyticsProps({ 'x-app-platform': 'windows', 'x-app-version': '1.0.0+42' }), {});
  assert.deepEqual(clientAnalyticsProps({ 'x-app-platform': 'ios; DROP', 'x-app-version': '1.2.3-beta' }), {});
  assert.deepEqual(clientAnalyticsProps({ 'x-app-version': '1'.repeat(21) }), {});
  assert.deepEqual(clientAnalyticsProps({ 'x-app-version': '1.' }), {});
  assert.deepEqual(clientAnalyticsProps({ 'x-app-platform': ['ios', 'android'] }), { platform: 'ios' });
  assert.deepEqual(clientAnalyticsProps({}), {});
  assert.deepEqual(clientAnalyticsProps(undefined), {});
});

const events = [];
let svc;

test('setup: mock dependencies, import authService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = {
            findUnique: async () => ({ id: 7, role: 'customer', type: 'general', isActive: true, linkedGymId: 1 }),
          };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../utils/analytics.js', import.meta.url).href, {
    exports: { track: (name, id, props) => { events.push({ name, id, props }); }, ingest: () => {}, default: {} },
  });
  t.mock.module(new URL('../services/refreshTokenService.js', import.meta.url).href, {
    exports: { issueRefreshFamily: async () => 'rt', rotate: async () => ({}), revokeByToken: async () => {} },
  });
  t.mock.module(new URL('../utils/generateTokens.js', import.meta.url).href, {
    exports: { generateAccessToken: () => 'at' },
  });
  // imported dynamically later, so it must outlive this setup test
  mock.module(new URL('../utils/firebaseAdmin.js', import.meta.url).href, {
    exports: { verifyFirebaseIdToken: async () => ({ phone_number: '+919999999999' }) },
  });
  svc = await import('../services/authService.js');
});

test('login_completed carries a valid platform and app_version', async () => {
  events.length = 0;
  await svc.verifyFirebaseTokenService({ idToken: 'x' }, clientAnalyticsProps({ 'x-app-platform': 'android', 'x-app-version': '3.1.0' }));
  const e = events.find((x) => x.name === 'login_completed');
  assert.equal(e.props.platform, 'android');
  assert.equal(e.props.app_version, '3.1.0');
  assert.equal(e.props.role, 'customer');
});

test('login_completed has no platform keys without (or with bad) headers', async () => {
  events.length = 0;
  await svc.verifyFirebaseTokenService({ idToken: 'x' });
  await svc.verifyFirebaseTokenService({ idToken: 'x' }, clientAnalyticsProps({ 'x-app-platform': 'toaster' }));
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal('platform' in e.props, false);
    assert.equal('app_version' in e.props, false);
  }
});
