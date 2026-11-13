import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gymLinkStatus } from '../utils/gymLinkStatus.js';

test('one booked visit cannot approve a membership request', () => {
  assert.equal(gymLinkStatus({ source: 'self', firstVerifiedCheckinAt: new Date(), approvedAt: null }), 'pending');
  assert.equal(gymLinkStatus({ source: 'self', approvedAt: new Date() }), 'approved');
  assert.equal(gymLinkStatus({ source: 'gym_qr' }), 'approved'); // existing approved members
  assert.equal(gymLinkStatus(null), null);
});
