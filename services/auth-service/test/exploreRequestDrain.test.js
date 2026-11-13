// Only /explore requests need the deliver-before-response outbox drain. It used to
// run (a BEGIN / SELECT FOR UPDATE SKIP LOCKED / COMMIT transaction) before every
// auth response, including GET /me, adding Neon round-trips to every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExploreRequest } from '../exploration/telemetry.js';

test('explore requests are drained before the response', () => {
  for (const originalUrl of [
    '/explore',
    '/explore/',
    '/explore/pickup',
    '/explore/feed?cursor=abc',
    '/explore?x=1',
  ]) assert.equal(isExploreRequest({ originalUrl }), true, originalUrl);
});

test('every other auth request skips the drain', () => {
  for (const originalUrl of [
    '/me',
    '/refresh-token',
    '/app-config',
    '/users/5',
    '/users/5/addresses',
    '/exploreish', // prefix match must respect the path boundary
    '/explorer/me',
    '/internal/5',
    '/admin/explore-settings',
    '/',
    '',
  ]) assert.equal(isExploreRequest({ originalUrl }), false, originalUrl);
});

test('uses the full original URL: a mounted router sees a mount-relative req.path', () => {
  // Inside router.use('/explore', ...) Express rewrites req.url/req.path to '/pickup',
  // but originalUrl keeps '/explore/pickup'. The check must follow originalUrl.
  assert.equal(isExploreRequest({ originalUrl: '/explore/pickup', url: '/pickup', path: '/pickup' }), true);
  assert.equal(isExploreRequest({ originalUrl: '/me', url: '/me', path: '/me' }), false);
});

test('falls back to url, and tolerates a missing request', () => {
  assert.equal(isExploreRequest({ url: '/explore/x' }), true);
  assert.equal(isExploreRequest({}), false);
  assert.equal(isExploreRequest(undefined), false);
});
