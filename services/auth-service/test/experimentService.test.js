// The tab-bar experiment service (services/experimentService.js). The A/B test
// was ended by the founder on 2026-10-14: at ~60 users the 50/50 split could
// not produce a meaningful result, so bucketFor now pins every user to the
// control. 'A' = no Bookings tab. Installed app builds still read
// experiments.tabBar off GET /me, so the shape must stay even though the value
// is now a constant. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bucketFor } from '../services/experimentService.js';

test('bucketFor: always returns the control, even and odd ids alike', () => {
  // The old hash split on userId parity (even -> A, odd -> B). Both sides must
  // now collapse to 'A' so no user gets the Bookings tab.
  const evenIds = [0, 2, 8, 42, 100, 1234, 100000];
  const oddIds = [1, 3, 7, 15, 99, 99999, 100001];

  for (const userId of [...evenIds, ...oddIds]) {
    assert.deepEqual(bucketFor(userId), { tabBar: 'A' }, `userId=${userId}`);
  }
});

test('bucketFor: the exposed shape is unchanged - a plain { tabBar } object', () => {
  const bucket = bucketFor(7);
  assert.deepEqual(Object.keys(bucket), ['tabBar']);
  assert.equal(bucket.tabBar, 'A');
});
