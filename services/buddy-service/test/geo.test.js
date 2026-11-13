// Buddy geo helpers (utils/geo.js): haversine distance, the pre-filter
// bounding box, and the deliberately bucketed distance labels that stop a
// shopper from ever learning a buddy's exact location. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let haversineKm, boundingBox, bucketDistanceKm;

test('setup: import geo', async () => {
  ({ haversineKm, boundingBox, bucketDistanceKm } = await import('../utils/geo.js'));
});

test('haversineKm: zero distance for identical points', () => {
  assert.equal(haversineKm(28.6139, 77.209, 28.6139, 77.209), 0);
});

test('haversineKm: Delhi → Gurugram is ~25 km (tolerance 3 km)', () => {
  const d = haversineKm(28.6139, 77.209, 28.4595, 77.0266);
  assert.ok(d > 22 && d < 28, `got ${d}`);
});

test('haversineKm: symmetric', () => {
  const a = haversineKm(12.97, 77.59, 19.07, 72.87);
  const b = haversineKm(19.07, 72.87, 12.97, 77.59);
  assert.equal(a, b);
});

test('haversineKm: ~1° of latitude is ~111 km', () => {
  const d = haversineKm(28.0, 77.0, 29.0, 77.0);
  assert.ok(d > 109 && d < 113, `got ${d}`);
});

test('haversineKm: behaves reasonably across the equator (symmetric, finite)', () => {
  const d = haversineKm(0, 0, 0.5, 0.5);
  assert.ok(Number.isFinite(d) && d > 50 && d < 90, `got ${d}`);
});

test('boundingBox: box center is the origin', () => {
  const box = boundingBox(28.6, 77.2, 5);
  assert.ok(box.minLat < 28.6 && box.maxLat > 28.6);
  assert.ok(box.minLng < 77.2 && box.maxLng > 77.2);
});

test('boundingBox: latitude half-width scales linearly with radius', () => {
  const small = boundingBox(20, 0, 1);
  const large = boundingBox(20, 0, 10);
  const smallSpan = small.maxLat - small.minLat;
  const largeSpan = large.maxLat - large.minLat;
  assert.ok(Math.abs(largeSpan / smallSpan - 10) < 1e-9);
});

test('boundingBox: longitude half-width grows away from the equator (cos latitude)', () => {
  const eq = boundingBox(0, 0, 10);
  const hi = boundingBox(80, 0, 10);
  assert.ok(hi.maxLng - hi.minLng > eq.maxLng - eq.minLng);
  assert.ok(Number.isFinite(eq.minLng) && Number.isFinite(eq.maxLng));
  assert.ok(Number.isFinite(hi.minLng) && Number.isFinite(hi.maxLng));
});

test('bucketDistanceKm: labels are <, not <=, at every boundary', () => {
  assert.equal(bucketDistanceKm(0), '< 1 km');
  assert.equal(bucketDistanceKm(0.999), '< 1 km');
  assert.equal(bucketDistanceKm(1), '1–3 km');
  assert.equal(bucketDistanceKm(2.99), '1–3 km');
  assert.equal(bucketDistanceKm(3), '3–5 km');
  assert.equal(bucketDistanceKm(4.99), '3–5 km');
  assert.equal(bucketDistanceKm(5), '5–10 km');
  assert.equal(bucketDistanceKm(9.99), '5–10 km');
  assert.equal(bucketDistanceKm(10), '10+ km');
  assert.equal(bucketDistanceKm(500), '10+ km');
});

test('bucketDistanceKm: non-finite distances fall through to the catch-all', () => {
  assert.equal(bucketDistanceKm(NaN), '10+ km');
  assert.equal(bucketDistanceKm(-1), '< 1 km');
});