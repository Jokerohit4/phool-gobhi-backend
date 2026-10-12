// W7 route gates, exercised over real HTTP against the real router:
//   - customer routes: requireRole('customer') + the buddy flag → 403
//     { error: "Gym buddy isn't available yet.", code: 'FEATURE_DISABLED' };
//   - admin report/moderation routes: requireRole('gobhi'), NO flag check;
//   - /internal/*: requireInternal only.
// The flag check fails closed when /app-config has never been reachable.
//
// Run with: node --experimental-test-module-mocks --test test/buddyRouteGates.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.INTERNAL_API_KEY = 'test-internal-key';

const tables = {
  buddyProfile: new Map(), buddyPhoto: new Map(), buddyFilter: new Map(),
  swipe: new Map(), match: new Map(), chatMessage: new Map(),
  blockedUser: new Map(), report: new Map(),
};
const fake = createFakePrisma(tables);

mock.module('@prisma/client', {
  exports: { PrismaClient: class { constructor() { return fake; } }, Prisma: {} },
});
mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
mock.module('../services/authClient.js', {
  exports: {
    getUserInternal: async (id) => ({ id, gender: 'male', dateOfBirth: '1995-01-01', fitnessGoals: [] }),
    getUsersBatchInternal: async (ids) => ids.map((id) => ({ id, name: 'User', profileImageUrl: '' })),
  },
});
mock.module('../utils/analytics.js', { exports: { track: () => {} } });
mock.module('../utils/notifyMatch.js', { exports: { notifyMatch: async () => {} } });
mock.module('../utils/notifyMessage.js', { exports: { notifyMessage: async () => {} } });
mock.module('../utils/upload.js', {
  exports: { MAX_BUDDY_PHOTOS: 6, uploadBuddyPhotos: { array: () => (req, res, next) => next() } },
});
mock.module('../config/cloudinary.js', {
  exports: { default: { uploader: { upload: async () => ({}), destroy: async () => {} } } },
});

// /app-config is answered by this switch; every other fetch (the test's own
// HTTP calls to the app) goes to the real network stack.
let appConfig = 'down'; // 'down' | 'off' | 'on'
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/app-config')) {
    if (appConfig === 'down') throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ features: { buddy: { enabled: appConfig === 'on' } } }) };
  }
  return realFetch(url, init);
};

const { default: express } = await import('express');
const { default: router } = await import('../routes/buddy.js');
const app = express();
app.use(express.json());
app.use('/', router);
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, { role = 'customer', userId = 1, body, headers = {} } = {}) {
  const res = await realFetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { 'x-user-id': String(userId), 'x-user-role': role } : {}),
      ...headers,
    },
    body: body && !['GET', 'HEAD'].includes(method) ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

const DISABLED = { error: "Gym buddy isn't available yet.", code: 'FEATURE_DISABLED' };

// Every route on the router, classified the way the contract does.
const allRoutes = router.stack
  .filter((l) => l.route)
  .flatMap((l) => Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route.path })));
const isInternal = (r) => r.path.startsWith('/internal/');
const isAdmin = (r) => r.path.startsWith('/moderation/') || (r.path.startsWith('/reports') && !(r.method === 'POST' && r.path === '/reports'));
const concrete = (path) => path.replace(/:[A-Za-z]+/g, '1');
const customerRoutes = allRoutes.filter((r) => !isInternal(r) && !isAdmin(r));
const adminRoutes = allRoutes.filter(isAdmin);

test('the router has the routes the contract names', () => {
  const names = allRoutes.map((r) => `${r.method} ${r.path}`);
  for (const r of [
    'POST /reports', 'GET /reports', 'PATCH /reports/:id', 'GET /reports/:id/context',
    'PATCH /reports/users/:userId/release-hold', 'PATCH /reports/users/:userId/reinstate',
    'GET /moderation/gender-changes', 'PATCH /moderation/gender-changes/:userId/clear',
    'PUT /filters', 'POST /internal/profile-sync/:userId', 'GET /internal/matches/:matchId/verify/:userId',
    'POST /internal/erase/:userId', 'GET /internal/export/:userId',
  ]) assert.ok(names.includes(r), r);
  assert.ok(customerRoutes.length >= 20, `found ${customerRoutes.length} customer routes`);
});

test('flag check fails closed while /app-config has never answered', async () => {
  appConfig = 'down';
  const res = await call('GET', '/profile/me');
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, DISABLED);
});

test('flag off: every customer route answers 403 FEATURE_DISABLED (not 404)', async () => {
  appConfig = 'off';
  for (const r of customerRoutes) {
    const res = await call(r.method, concrete(r.path), { body: {} });
    assert.equal(res.status, 403, `${r.method} ${r.path}`);
    assert.deepEqual(res.body, DISABLED, `${r.method} ${r.path}`);
  }
});

test('flag off: admin report and moderation routes still work for gobhi', async () => {
  appConfig = 'off';
  const list = await call('GET', '/reports', { role: 'gobhi', userId: 7 });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { data: [] });

  tables.report.set(1, {
    id: 1, reporterId: 2, reportedUserId: 3, reason: 'harassment', details: null, status: 'open',
    severity: 'normal', createdAt: new Date(), reviewedBy: null, reviewedAt: null, resolutionNote: null,
  });
  const review = await call('PATCH', '/reports/1', { role: 'gobhi', userId: 7, body: { status: 'dismissed' } });
  assert.equal(review.status, 200);
  assert.equal(review.body.data.status, 'dismissed');
  const ctx = await call('GET', '/reports/1/context', { role: 'gobhi', userId: 7 });
  assert.deepEqual(ctx.body, { messages: [] });
  const gc = await call('GET', '/moderation/gender-changes', { role: 'gobhi', userId: 7 });
  assert.deepEqual(gc.body, { data: [] });
});

test('flag off: a partner (or any non-customer) gets 403 Forbidden, a customer is refused admin routes', async () => {
  appConfig = 'off';
  for (const r of customerRoutes.slice(0, 5)) {
    const res = await call(r.method, concrete(r.path), { role: 'partner' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN', 'the role gate runs before the flag gate');
  }
  for (const r of adminRoutes) {
    for (const role of ['customer', 'partner']) {
      const res = await call(r.method, concrete(r.path), { role, body: {} });
      assert.equal(res.status, 403, `${role} ${r.method} ${r.path}`);
      assert.equal(res.body.code, 'FORBIDDEN');
    }
  }
  const anon = await call('GET', '/profile/me', { role: null });
  assert.equal(anon.status, 401);
});

test('flag off: /internal/* needs the internal key and nothing else', async () => {
  appConfig = 'off';
  const denied = await call('POST', '/internal/profile-sync/1', { role: null });
  assert.equal(denied.status, 403);
  const ok = await call('POST', '/internal/profile-sync/1', { role: null, headers: { 'x-internal-key': 'test-internal-key' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  const verify = await call('GET', '/internal/matches/1/verify/1', { role: null, headers: { 'x-internal-key': 'test-internal-key' } });
  assert.equal(verify.status, 200);
  assert.deepEqual(verify.body, { data: { matched: false } });
});

test('flag on: customer routes reach their handlers; partners are still refused', async (t) => {
  appConfig = 'on';
  // Step past the 30 s flag cache so the "on" value is fetched.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(31_000);
  const me = await call('GET', '/profile/me');
  assert.equal(me.status, 404, 'no profile yet — the handler ran');
  const partner = await call('GET', '/profile/me', { role: 'partner' });
  assert.equal(partner.status, 403);
});

test('teardown', () => {
  server.close();
  globalThis.fetch = realFetch;
});
