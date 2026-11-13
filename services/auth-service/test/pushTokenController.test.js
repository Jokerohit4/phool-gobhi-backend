import { test } from 'node:test';
import assert from 'node:assert/strict';

test('push-token endpoints validate identity and scope unregister', async t => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class {} } });
  const { pushTokenHandler } = await import('../controllers/pushTokenController.js');
  let query;
  const db = { user: { async updateMany(input) { query = input; } } };
  const handler = pushTokenHandler(db, true);
  function response() {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; } };
  }
  for (const token of [null, '', ' ', {}, 'x'.repeat(4097)]) {
    const res = response();
    await handler({ user: { id: 7 }, body: { fcmToken: token } }, res);
    assert.equal(res.statusCode, 400);
  }
  const unauthenticated = response();
  await handler({ body: { fcmToken: 'token' } }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
  const ok = response();
  await handler({ user: { id: 7 }, body: { fcmToken: 'token', userId: 99 } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(query.where, { id: 7, fcmToken: 'token' });
});
