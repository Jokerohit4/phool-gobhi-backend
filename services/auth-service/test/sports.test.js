import test from 'node:test';
import assert from 'node:assert/strict';
import { SPORTS, VALID_SPORTS, normalizeSportsPlayed } from '../constants/sports.js';

test('the catalog is unique lowercase slugs, with running and athletics both present', () => {
  assert.equal(new Set(SPORTS).size, SPORTS.length);
  for (const key of SPORTS) assert.match(key, /^[a-z]+(_[a-z]+)*$/);
  assert.ok(VALID_SPORTS.includes('running'));
  assert.ok(VALID_SPORTS.includes('athletics'));
});

test('a valid list is kept in order with duplicates collapsed', () => {
  assert.deepEqual(normalizeSportsPlayed(['tennis', 'football', 'tennis']), ['tennis', 'football']);
  assert.deepEqual(normalizeSportsPlayed([]), []);
});

test('anything else is rejected rather than partly accepted', () => {
  assert.equal(normalizeSportsPlayed('tennis'), null);
  assert.equal(normalizeSportsPlayed(['tennis', 'quidditch']), null);
  assert.equal(normalizeSportsPlayed(['tennis', 3]), null);
  assert.equal(normalizeSportsPlayed({ 0: 'tennis' }), null);
});
