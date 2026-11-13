// Road-distance labels are cosmetic (haversine filters and sorts), so ORS must
// never hold up the gym list. Pinned: a hung ORS is abandoned at the deadline,
// failures are remembered briefly instead of retried on every request,
// successes are cached, and identical concurrent lookups share one call.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ORS_API_KEY = 'test-key';
const { getRoadDistancesKm } = await import('../services/roadDistanceService.js');

const realFetch = globalThis.fetch;
let calls = 0;
// Each test uses its own coordinates: the service caches per rounded spot.
let lat = 10;
const nextSpot = () => { lat += 1; return [lat, 77]; };
const gyms = [{ id: 1, lat: 12.9, lng: 77.6 }, { id: 2, lat: 13.0, lng: 77.5 }];
const okBody = { distances: [[1500, 2600]] };

const respond = (body, ok = true, status = 200) => async () => {
  calls++;
  return { ok, status, json: async () => body };
};

test.afterEach(() => { globalThis.fetch = realFetch; calls = 0; });

test('a successful lookup converts metres to km and is cached', async () => {
  globalThis.fetch = respond(okBody);
  const [la, ln] = nextSpot();
  const first = await getRoadDistancesKm(la, ln, gyms);
  assert.deepEqual([...first], [[1, 1.5], [2, 2.6]]);
  await getRoadDistancesKm(la, ln, gyms);
  assert.equal(calls, 1, 'second call served from cache');
});

test('a hung ORS is abandoned at the deadline instead of stalling the list', async () => {
  let signalSeen;
  globalThis.fetch = (_url, opts) => {
    calls++;
    signalSeen = opts.signal;
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  };
  const [la, ln] = nextSpot();
  const started = Date.now();
  const out = await getRoadDistancesKm(la, ln, gyms);
  assert.ok(signalSeen, 'the request carries an abort signal');
  assert.equal(out.size, 0, 'falls back (empty map -> caller uses haversine)');
  assert.ok(Date.now() - started < 4000, 'returned at the deadline, not after the hang');
});

test('a failure (5xx) is remembered, so the next request does not pay it again', async () => {
  globalThis.fetch = respond({}, false, 503);
  const [la, ln] = nextSpot();
  assert.equal((await getRoadDistancesKm(la, ln, gyms)).size, 0);
  assert.equal((await getRoadDistancesKm(la, ln, gyms)).size, 0);
  assert.equal((await getRoadDistancesKm(la, ln, gyms)).size, 0);
  assert.equal(calls, 1, 'one failed call, then served from the negative cache');
});

test('a network error is also remembered', async () => {
  globalThis.fetch = async () => { calls++; throw new Error('ECONNRESET'); };
  const [la, ln] = nextSpot();
  assert.equal((await getRoadDistancesKm(la, ln, gyms)).size, 0);
  assert.equal((await getRoadDistancesKm(la, ln, gyms)).size, 0);
  assert.equal(calls, 1);
});

test('a malformed body counts as a failure', async () => {
  globalThis.fetch = respond({ unexpected: true });
  const [la, ln] = nextSpot();
  assert.equal((await getRoadDistancesKm(la, ln, gyms)).size, 0);
  assert.equal((await getRoadDistancesKm(la, ln, gyms)).size, 0);
  assert.equal(calls, 1);
});

test('identical concurrent lookups share one ORS call', async () => {
  globalThis.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, json: async () => okBody }; };
  const [la, ln] = nextSpot();
  const results = await Promise.all([1, 2, 3, 4].map(() => getRoadDistancesKm(la, ln, gyms)));
  assert.equal(calls, 1);
  assert.ok(results.every((m) => m.get(1) === 1.5));
});

test('a different set of gyms for the same spot is not served the wrong cache entry', async () => {
  globalThis.fetch = respond(okBody);
  const [la, ln] = nextSpot();
  await getRoadDistancesKm(la, ln, gyms);
  await getRoadDistancesKm(la, ln, [gyms[0]]);
  assert.equal(calls, 2);
});

test('no gyms means no call', async () => {
  globalThis.fetch = respond(okBody);
  const [la, ln] = nextSpot();
  assert.equal((await getRoadDistancesKm(la, ln, [])).size, 0);
  assert.equal(calls, 0);
});
