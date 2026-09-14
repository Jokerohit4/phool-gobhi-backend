// Gateway trust-boundary tests: isPublicRoute gating, authMiddleware JWT
// verification + header injection/stripping, and the /api/events analytics
// allowlist + enrichment pipeline. The gateway is the only component allowed
// to set x-user-*/x-internal-key headers, so this is where a spoofed
// identity would otherwise slip through. Run with:
//   node --experimental-test-module-mocks --test test/gateway.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.INTERNAL_API_KEY = 'test-internal-key';

const ingestCalls = [];
const UAParserResult = {
  os: { name: 'Android', version: '14' },
  browser: { name: 'Chrome', version: '120.0' },
  device: { type: 'mobile' },
};

let isPublicRoute, authMiddleware, eventsHandler;

test('setup: mock proxy/rate-limit/analytics/ua-parser, import gateway once', async (t) => {
  t.mock.module('express-http-proxy', { exports: { default: () => () => {} } });
  t.mock.module('express-rate-limit', { exports: { default: () => () => {} } });
  t.mock.module('../utils/analytics.js', { exports: { ingest: (payload) => ingestCalls.push(payload) } });
  t.mock.module('ua-parser-js', {
    exports: {
      default: class MockUAParser { getResult() { return UAParserResult; } },
      UAParser: class MockUAParser { getResult() { return UAParserResult; } },
    },
  });
  ({ isPublicRoute, authMiddleware, eventsHandler } = await import('../index.js'));
  assert.equal(typeof isPublicRoute, 'function');
  assert.equal(typeof authMiddleware, 'function');
  assert.equal(typeof eventsHandler, 'function');
});

// ---- isPublicRoute ---------------------------------------------------------

test('isPublicRoute: true for the public read/list routes', () => {
  assert.equal(isPublicRoute('GET', '/api/gyms'), true);
  assert.equal(isPublicRoute('GET', '/api/gyms?lat=28.0&lng=77.0'), true);
  assert.equal(isPublicRoute('GET', '/api/gyms/123'), true);
  assert.equal(isPublicRoute('GET', '/api/gyms/123/slots'), true);
  assert.equal(isPublicRoute('GET', '/api/gyms/123/reviews'), true);
  assert.equal(isPublicRoute('GET', '/api/gyms/123/subscription-plans'), true);
  assert.equal(isPublicRoute('GET', '/api/gyms/123/classes'), true);
  assert.equal(isPublicRoute('GET', '/api/gyms/123/classes/99/occurrences'), true);
  assert.equal(isPublicRoute('GET', '/api/auth/otp-config'), true);
  assert.equal(isPublicRoute('GET', '/api/auth/app-config'), true);
  assert.equal(isPublicRoute('GET', '/api/auth/jobs?active=true'), true);
  assert.equal(isPublicRoute('GET', '/api/auth/platform-reviews'), true);
  assert.equal(isPublicRoute('POST', '/api/auth/send-otp'), true);
  assert.equal(isPublicRoute('POST', '/api/auth/verify-otp'), true);
  assert.equal(isPublicRoute('POST', '/api/auth/verify-firebase-token'), true);
  assert.equal(isPublicRoute('POST', '/api/auth/google'), true);
  assert.equal(isPublicRoute('POST', '/api/wallet/webhooks/razorpay'), true);
  assert.equal(isPublicRoute('POST', '/api/events'), true);
  assert.equal(isPublicRoute('GET', '/api/bookings/public/attendance-stats'), true);
  assert.equal(isPublicRoute('GET', '/health'), true);
});

test('isPublicRoute: false once the method stops matching the pattern', () => {
  assert.equal(isPublicRoute('POST', '/api/gyms'), false);
  assert.equal(isPublicRoute('DELETE', '/api/gyms/123'), false);
  assert.equal(isPublicRoute('POST', '/api/gyms/123/slots'), false);
  assert.equal(isPublicRoute('GET', '/api/wallet/webhooks/razorpay'), false);
  assert.equal(isPublicRoute('POST', '/api/wallet/orders'), false);
  assert.equal(isPublicRoute('GET', '/api/wallet/balance'), false);
  assert.equal(isPublicRoute('GET', '/api/bookings/mine'), false);
  assert.equal(isPublicRoute('GET', '/api/buddy/discovery'), false);
  assert.equal(isPublicRoute('POST', '/api/buddy/swipes'), false);
  assert.equal(isPublicRoute('POST', '/api/auth/pitch-access/check'), true); // POST-only auth route
});

test('isPublicRoute: an unanchored /slots prefix covers deeper subpaths, but method still gates', () => {
  assert.equal(isPublicRoute('GET', '/api/gyms/123/slots/666'), true); // unanchored by design
  assert.equal(isPublicRoute('POST', '/api/gyms/123/slots/666'), false);
  assert.equal(isPublicRoute('POST', '/api/events2'), false);
  assert.equal(isPublicRoute('GET', '/api/gyms/123?admin=true'), true);   // public GET still public
  assert.equal(isPublicRoute('GET', '/api/health'), false);               // only /health exactly is public
});

// ---- authMiddleware --------------------------------------------------------

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('authMiddleware: strips client-supplied identity/internal headers unconditionally', () => {
  const req = {
    method: 'GET', path: '/api/gyms',
    headers: {
      'x-user-id': '999', 'x-user-role': 'gobhi', 'x-user-type': 'premium', 'x-internal-key': 'stolen',
    },
  };
  const res = makeRes();
  let called = false;
  authMiddleware(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.headers['x-user-id'], undefined);
  assert.equal(req.headers['x-user-role'], undefined);
  assert.equal(req.headers['x-user-type'], undefined);
  assert.equal(req.headers['x-internal-key'], undefined);
});

test('authMiddleware: public route passes through with no token', () => {
  const req = { method: 'GET', path: '/api/gyms', headers: {} };
  const res = makeRes();
  let called = false;
  authMiddleware(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('authMiddleware: protected route without a token -> 401 Unauthorized', () => {
  const req = { method: 'GET', path: '/api/wallet/balance', headers: {} };
  const res = makeRes();
  authMiddleware(req, res, () => { throw new Error('next must not be called'); });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
});

test('authMiddleware: valid JWT injects identity headers and forwards', () => {
  const token = jwt.sign({ id: 42, role: 'customer', type: 'premium' }, process.env.JWT_SECRET);
  const req = { method: 'POST', path: '/api/bookings', headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  let called = false;
  authMiddleware(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.headers['x-user-id'], '42');
  assert.equal(req.headers['x-user-role'], 'customer');
  assert.equal(req.headers['x-user-type'], 'premium');
});

test('authMiddleware: token without role/type fills empty strings', () => {
  const token = jwt.sign({ id: 7 }, process.env.JWT_SECRET);
  const req = { method: 'GET', path: '/api/buddy/discovery', headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  authMiddleware(req, res, () => {});
  assert.equal(req.headers['x-user-id'], '7');
  assert.equal(req.headers['x-user-role'], '');
  assert.equal(req.headers['x-user-type'], '');
});

test('authMiddleware: bad signature -> 401 Invalid token', () => {
  const token = jwt.sign({ id: 1 }, 'wrong-secret');
  const req = { method: 'GET', path: '/api/wallet/balance', headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  authMiddleware(req, res, () => { throw new Error('next must not be called'); });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid token' });
});

test('authMiddleware: expired token -> 401 Token expired (drives client refresh)', (t) => {
  const PINNED_NOW = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: PINNED_NOW });
  const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: '-30s' });
  const req = { method: 'GET', path: '/api/wallet/balance', headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  authMiddleware(req, res, () => { throw new Error('next must not be called'); });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Token expired' });
});

test('authMiddleware: malformed/garbage token -> 401 Invalid token', () => {
  const req = { method: 'GET', path: '/api/wallet/balance', headers: { authorization: 'Bearer not-a-jwt' } };
  const res = makeRes();
  authMiddleware(req, res, () => { throw new Error('next must not be called'); });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid token' });
});

// ---- /api/events handler ----------------------------------------------------

function eventsReq(body, headers = {}) {
  return { body, headers, ip: '10.20.30.40' };
}

test('eventsHandler: single allowed event is ingested with enrichment', () => {
  ingestCalls.length = 0;
  const res = makeRes();
  eventsHandler(eventsReq({ event: 'otp_requested', distinct_id: 'anon-1', properties: { screen: 'login' } },
    { 'user-agent': 'Mozilla/5.0' }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(ingestCalls.length, 1);
  const call = ingestCalls[0];
  assert.equal(call.event, 'otp_requested');
  assert.equal(call.distinctId, 'anon-1');
  assert.equal(call.source, 'client');
  assert.equal(call.properties.screen, 'login');
  assert.equal(call.properties.user_agent, 'Mozilla/5.0');
  assert.equal(call.properties.ip, '10.20.30.40');
  assert.equal(call.properties.os_name, 'Android');
  assert.equal(call.properties.device_type, 'mobile');
});

test('eventsHandler: batch of N valid events -> N ingests', () => {
  ingestCalls.length = 0;
  const res = makeRes();
  eventsHandler(eventsReq({ events: [
    { event: 'screen_viewed', distinct_id: 'd1' },
    { event: 'search_performed', distinct_id: 'd2', properties: { query: 'crossfit' } },
  ] }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(ingestCalls.length, 2);
  assert.equal(ingestCalls[0].event, 'screen_viewed');
  assert.equal(ingestCalls[1].properties.query, 'crossfit');
});

test('eventsHandler: unknown event name is silently dropped (still 202)', () => {
  ingestCalls.length = 0;
  const res = makeRes();
  eventsHandler(eventsReq({ events: [
    { event: 'totally_made_up_event', distinct_id: 'd1' },
    { event: 'otp_requested', distinct_id: 'd2' },
  ] }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(ingestCalls.length, 1);
  assert.equal(ingestCalls[0].distinctId, 'd2');
});

test('eventsHandler: skips malformed entries instead of failing the batch', () => {
  ingestCalls.length = 0;
  const res = makeRes();
  eventsHandler(eventsReq({ events: [
    null,
    { event: 42 },
    {},
    { event: 'otp_requested', distinct_id: 123 },                       // distinct_id not a string
    { event: 'otp_requested', distinct_id: 'x'.repeat(201) },           // >200 chars
    { event: 'otp_requested', properties: [] },                         // properties must be object
    { event: 'search_performed', distinct_id: 'good' },                // the one that should pass
  ] }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(ingestCalls.length, 1);
  assert.equal(ingestCalls[0].distinctId, 'good');
});

test('eventsHandler: client-supplied rich fields are never overwritten by backstop enrichment', () => {
  ingestCalls.length = 0;
  const res = makeRes();
  eventsHandler(eventsReq({
    event: 'screen_viewed', distinct_id: 'd1',
    properties: { user_agent: 'custom-agent', os_name: 'iOS', device_type: 'tablet' },
  }, { 'user-agent': 'Mozilla/5.0' }), res);
  const call = ingestCalls[0];
  assert.equal(call.properties.user_agent, 'custom-agent');
  assert.equal(call.properties.os_name, 'iOS');
  assert.equal(call.properties.device_type, 'tablet');
});

test('eventsHandler: never throws even on a garbage body', () => {
  ingestCalls.length = 0;
  const res = makeRes();
  eventsHandler(eventsReq('just a string', {}), res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true });
  eventsHandler(eventsReq({ events: 'not-an-array' }, {}), res);
  assert.equal(res.statusCode, 202);
});