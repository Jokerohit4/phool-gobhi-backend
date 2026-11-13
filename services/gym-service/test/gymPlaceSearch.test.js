// Gym-only Places search (services/placesService.js searchGyms).
//
// The bug this guards: the own-gym picker reused ADDRESS autocomplete, so
// "golds" returned a canteen in Goa and a housing society in Mira Road. These
// tests pin the contract that replaced it — gym type, location bias, nearest
// first, and a second non-gym filter in case Google ever leaks one through.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchGyms, GYM_SEARCH_RADIUS_M, GYM_NEARBY_RADIUS_M } from '../services/placesService.js';

const realFetch = globalThis.fetch;
let calls;
let reply;

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  calls = [];
  reply = { status: 'OK', results: [] };
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return { json: async () => reply };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const HERE = { lat: 28.4595, lng: 77.0266 }; // Gurugram

function place(over = {}) {
  return {
    place_id: 'p1',
    name: "Gold's Gym",
    formatted_address: 'Sector 29, Gurugram',
    geometry: { location: { lat: 28.47, lng: 77.06 } },
    types: ['gym', 'health', 'point_of_interest'],
    ...over,
  };
}

test('typed search uses Text Search restricted to type=gym, biased to the user', async () => {
  reply.results = [place()];
  const out = await searchGyms({ query: ' golds ', location: HERE });
  assert.equal(calls.length, 1);
  const u = calls[0];
  assert.match(u.pathname, /textsearch\/json$/);
  assert.equal(u.searchParams.get('query'), 'golds');
  assert.equal(u.searchParams.get('type'), 'gym');
  assert.equal(u.searchParams.get('region'), 'in');
  assert.equal(u.searchParams.get('location'), `${HERE.lat},${HERE.lng}`);
  assert.equal(u.searchParams.get('radius'), String(GYM_SEARCH_RADIUS_M));
  assert.equal(out[0].placeId, 'p1');
  assert.equal(out[0].name, "Gold's Gym");
  assert.ok(out[0].distanceMeters > 0 && out[0].distanceMeters < 10000);
});

test('typed search without location is still gym-only, just unbiased and distance-less', async () => {
  reply.results = [place()];
  const out = await searchGyms({ query: 'golds' });
  const u = calls[0];
  assert.equal(u.searchParams.get('type'), 'gym');
  assert.equal(u.searchParams.get('location'), null);
  assert.equal(out[0].distanceMeters, null);
});

test('non-gym results are dropped even if Google returns them', async () => {
  reply.results = [
    place({ place_id: 'canteen', name: 'Goldspot - Canteen', types: ['restaurant', 'food'] }),
    place({ place_id: 'homes', name: 'Goldstar Decent Homes', types: ['premise'] }),
    place({ place_id: 'fc', name: 'Gold Fitness Centre', types: ['fitness_center'] }),
    place({ place_id: 'gym' }),
  ];
  const out = await searchGyms({ query: 'gold', location: HERE });
  assert.deepEqual(out.map((r) => r.placeId).sort(), ['fc', 'gym']);
});

test('results are nearest first when location is known', async () => {
  reply.results = [
    place({ place_id: 'far', geometry: { location: { lat: 28.6, lng: 77.2 } } }),
    place({ place_id: 'near', geometry: { location: { lat: 28.46, lng: 77.03 } } }),
  ];
  const out = await searchGyms({ query: 'gym', location: HERE });
  assert.deepEqual(out.map((r) => r.placeId), ['near', 'far']);
});

test('empty query with location lists gyms nearby via Nearby Search', async () => {
  reply.results = [place({ formatted_address: undefined, vicinity: 'DLF Phase 1' })];
  const out = await searchGyms({ query: '', location: HERE });
  const u = calls[0];
  assert.match(u.pathname, /nearbysearch\/json$/);
  assert.equal(u.searchParams.get('type'), 'gym');
  assert.equal(u.searchParams.get('radius'), String(GYM_NEARBY_RADIUS_M));
  assert.equal(out[0].address, 'DLF Phase 1');
});

test('empty query without location returns nothing and costs no Places call', async () => {
  const out = await searchGyms({ query: '' });
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

test('ZERO_RESULTS is an empty list, other statuses are a 502', async () => {
  reply = { status: 'ZERO_RESULTS', results: [] };
  assert.deepEqual(await searchGyms({ query: 'nothing', location: HERE }), []);
  reply = { status: 'REQUEST_DENIED', error_message: 'API not enabled' };
  await assert.rejects(searchGyms({ query: 'x', location: HERE }), (e) => e.status === 502);
});

test('results are capped at 20', async () => {
  reply.results = Array.from({ length: 25 }, (_, i) => place({ place_id: `p${i}` }));
  const out = await searchGyms({ query: 'gym', location: HERE });
  assert.equal(out.length, 20);
});
