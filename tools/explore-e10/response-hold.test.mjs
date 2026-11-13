// Harness regression only: real loopback Express and client timeout, no DB/service imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPostCommitResponseHold } from './response-hold.mjs';

async function fixture() {
  const hold = createPostCommitResponseHold();
  const reached = Promise.withResolvers(), closed = Promise.withResolvers();
  const auth = express(); auth.use(express.json()); auth.use(hold.middleware);
  // Same topology as postgres.test: auth app -> '/' auth routes -> '/explore' router.
  const authRoutes = express.Router(), exploreRoutes = express.Router();
  exploreRoutes.post('/pickups', (req, res) => {
    const trace = { path: req.path, originalUrl: req.originalUrl, baseUrl: req.baseUrl };
    const result = req.body.result ?? 'saved';
    if (result === 'saved') res.once('close', closed.resolve);
    res.json({ data: { result, receiptId: 'synthetic-harness-receipt' } });
    if (result === 'saved') reached.resolve(trace);
  });
  authRoutes.use('/explore', exploreRoutes);
  authRoutes.get('/health', (_req, res) => res.json({ data: { result: 'saved' } }));
  auth.use('/', authRoutes);
  const server = auth.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pickup = (result = 'saved', timeout = 1000) => fetch(base + '/explore/pickups', {
    method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ result }),
  });
  return { hold, reached, closed, base, pickup, async cleanup() {
    hold.release();
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    assert.equal(server.listening, false);
    assert.equal(hold.pending, false);
    assert.equal(hold.armed, false);
  } };
}

test('nested Express saved response is held through client timeout, then safely released after disconnect', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    f.hold.arm();
    const timedOut = assert.rejects(f.pickup(), error => error.name === 'TimeoutError');
    assert.deepEqual(await f.reached.promise, { path: '/pickups', originalUrl: '/explore/pickups', baseUrl: '/explore' });
    assert.equal(f.hold.pending, true);
    await timedOut;
    await f.closed.promise;
    assert.equal(f.hold.pending, true);
    assert.doesNotThrow(() => f.hold.release());
    assert.equal(f.hold.pending, false);
    assert.doesNotThrow(() => f.hold.release());
    const normal = await f.pickup();
    assert.equal(normal.status, 200);
    assert.equal((await normal.json()).data.result, 'saved');
  } finally { await f.cleanup(); }
});

test('hold ignores other URLs/replayed responses and releases a live saved response intact', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    f.hold.arm();
    assert.equal((await fetch(f.base + '/health')).status, 200);
    assert.equal((await f.pickup('already_saved')).status, 200);
    assert.equal(f.hold.pending, false); assert.equal(f.hold.armed, true);
    const pendingResponse = f.pickup('saved', 3000);
    await f.reached.promise; assert.equal(f.hold.pending, true);
    f.hold.release();
    const response = await pendingResponse;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { result: 'saved', receiptId: 'synthetic-harness-receipt' } });
    assert.equal(f.hold.pending, false); assert.equal(f.hold.armed, false);
    assert.doesNotThrow(() => f.hold.release());
  } finally { await f.cleanup(); }
});
