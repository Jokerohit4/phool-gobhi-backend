import assert from 'node:assert/strict';

export function assertRetryableError(response, code = 'INTERNAL_ERROR') {
  assert.ok(['INTERNAL_ERROR', 'WORLD_UNAVAILABLE'].includes(code));
  assert.equal(response.status, code === 'INTERNAL_ERROR' ? 500 : 503);
  assert.match(response.body?.error?.requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(response.body, { error: { code, messageKey: `explore.error.${code.toLowerCase()}`,
    retryable: true, requestId: response.body.error.requestId } });
  assert.equal(response.retryAfter, code === 'INTERNAL_ERROR' ? null : '5');
}

// Hosted native callers invoke this only after removing their injected trigger.
export async function verifyRecoveryReplay({ db, pickup, userId, command, rejected = false }) {
  const first = await pickup(command, userId);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.result, rejected ? 'rejected' : 'saved');
  if (rejected) assert.equal(first.body.data.reason.code, 'FIX_INACCURATE');
  const models = ['exploreLocationReceipt', 'exploreProgress', 'exploreClaim', 'exploreReceiptEvent'];
  const state = async () => Object.fromEntries(await Promise.all(models.map(async model =>
    [model, await db[model].findMany({ where: { userId } })])));
  const before = await state();
  assert.equal(before.exploreLocationReceipt.length, rejected ? 0 : 1);
  assert.equal(before.exploreProgress.length, 1);
  assert.equal(before.exploreProgress[0].revision, rejected ? 0 : 1);
  assert.equal(before.exploreClaim.length, 1);
  assert.equal(before.exploreReceiptEvent.length, 1);
  assert.equal(before.exploreReceiptEvent[0].event, rejected ? 'explore_pickup_rejected' : 'explore_pickup_saved');
  if (rejected) assert.equal(before.exploreReceiptEvent[0].claimId, command.claimId);
  else assert.equal(before.exploreReceiptEvent[0].receiptId, first.body.data.receipt.receiptId);
  for (let i = 0; i < 3; i++) {
    const replay = await pickup(command, userId);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.result, rejected ? 'rejected' : 'already_saved');
    assert.deepEqual(replay.body.data.receipt, first.body.data.receipt);
    assert.deepEqual(replay.body.data.reason, first.body.data.reason);
    assert.deepEqual(await state(), before, 'replay must not add or mutate receipt/progress/claim/outcome rows');
  }
}
