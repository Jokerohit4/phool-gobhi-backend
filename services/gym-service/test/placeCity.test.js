import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cityFromCoordinates } from '../services/placesService.js';

const originalFetch = globalThis.fetch, originalKey = process.env.GOOGLE_MAPS_API_KEY;
let body, requests, ok;
beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = 'unit-test-key';
  requests = [];ok = true;
  body = { status: 'OK', results: [{ address_components: [{ long_name: 'Gurugram', types: ['locality', 'political'] }] }] };
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok, json: async () => body }; };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = originalKey;
});
test('GPS resolves locality components in address results with a bounded provider request', async () => {
  body.results[0].types = ['street_address'];
  assert.deepEqual(await cityFromCoordinates(28.45, 77.03), { city: 'Gurugram' });
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('latlng'), '28.45,77.03');
  assert.equal(url.searchParams.has('result_type'), false);
  assert.ok(requests[0].options.signal);
});
test('a Gurugram district alone is never treated as Gurugram city', async () => {
  body.results[0].address_components = [{ long_name: 'Gurugram', types: ['administrative_area_level_2', 'political'] }];
  await assert.rejects(cityFromCoordinates(28.3, 76.9), { status: 422 });
  body = { status: 'ZERO_RESULTS', results: [] };
  await assert.rejects(cityFromCoordinates(28.3, 76.9), { status: 422 });
});
test('bad coordinates never reach the provider; provider failures expose no key or details', async () => {
  for (const pair of [[null, 77], ['28', 77], [91, 77], [28, 181], [NaN, 77]]) {
    await assert.rejects(cityFromCoordinates(...pair), { status: 400 });
  }
  assert.equal(requests.length, 0);
  body = { status: 'REQUEST_DENIED', error_message: 'sensitive provider details' };
  await assert.rejects(cityFromCoordinates(28, 77), { status: 502, error: 'Could not resolve your city' });
  ok = false;
  await assert.rejects(cityFromCoordinates(28, 77), { status: 502 });
});
