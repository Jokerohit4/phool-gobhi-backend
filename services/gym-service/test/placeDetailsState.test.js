// Places proxy: place details must carry the state (a gym row requires one and
// the partner app has no other way to learn it), and autocomplete predictions
// carry the structured main/secondary text for display.
// Run with: node --experimental-test-module-mocks --test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { placeDetails, autocomplete } from '../services/placesService.js';

const realFetch = globalThis.fetch;
let reply;

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  reply = {};
  globalThis.fetch = async () => ({ json: async () => reply });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const comp = (long_name, ...types) => ({ long_name, types });

test('details return the state alongside city, address and coordinates', async () => {
  reply = {
    status: 'OK',
    result: {
      name: "Gold's Gym",
      formatted_address: 'Sector 29, Gurugram, Haryana',
      geometry: { location: { lat: 28.47, lng: 77.06 } },
      address_components: [
        comp('Gurugram', 'locality', 'political'),
        comp('Haryana', 'administrative_area_level_1', 'political'),
      ],
    },
  };
  const d = await placeDetails('p1', 'tok');
  assert.equal(d.state, 'Haryana');
  assert.equal(d.city, 'Gurugram');
  assert.equal(d.lat, 28.47);
});

test('a place with no state component yields an empty state, not a crash', async () => {
  reply = {
    status: 'OK',
    result: { name: 'X', geometry: { location: { lat: 1, lng: 2 } }, address_components: [] },
  };
  assert.equal((await placeDetails('p1')).state, '');
});

test('predictions carry structured main and secondary text when Google sends it', async () => {
  reply = {
    status: 'OK',
    predictions: [
      {
        place_id: 'p1',
        description: "Gold's Gym, Sector 29, Gurugram",
        structured_formatting: { main_text: "Gold's Gym", secondary_text: 'Sector 29, Gurugram' },
      },
      { place_id: 'p2', description: 'Somewhere' },
    ],
  };
  const out = await autocomplete('golds', 'tok', null);
  assert.equal(out[0].mainText, "Gold's Gym");
  assert.equal(out[0].secondaryText, 'Sector 29, Gurugram');
  assert.equal(out[1].mainText, null);
  assert.equal(out[1].description, 'Somewhere');
});
