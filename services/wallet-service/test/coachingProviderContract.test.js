import { test } from 'node:test';
import assert from 'node:assert/strict';
import Razorpay from 'razorpay';

test('installed provider SDK exposes the coaching capture/refund/recovery methods', () => {
  // No network calls: check the installed SDK boundary, not mocked aliases.
  const provider = new Razorpay({ key_id: 'rzp_test_contract', key_secret: 'not-a-real-secret' });
  for (const key of ['create', 'fetchPayments']) assert.equal(typeof provider.orders[key], 'function');
  for (const key of ['fetch', 'capture', 'refund', 'fetchMultipleRefund']) assert.equal(typeof provider.payments[key], 'function');
});
