import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindPushToken, unbindPushToken } from '../services/pushTokenService.js';

function database() {
  const users = [{ id: 1, fcmToken: 'shared-device' }, { id: 2, fcmToken: '' }];
  const db = {
    user: {
      async updateMany({ where, data }) {
        assert.equal(typeof data.fcmToken, 'string', 'Prisma User.fcmToken is non-nullable');
        for (const user of users) {
          const matchesId = typeof where.id === 'number' ? user.id === where.id : user.id !== where.id.not;
          if (matchesId && user.fcmToken === where.fcmToken) Object.assign(user, data);
        }
      },
      async update({ where, data }) { Object.assign(users.find(u => u.id === where.id), data); },
    },
    async $transaction(action, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      return action(db);
    },
  };
  return { db, users };
}

test('registering a shared device removes the previous owner', async () => {
  const { db, users } = database();
  await bindPushToken(db, 2, 'shared-device');
  assert.equal(users[0].fcmToken, '');
  assert.equal(users[1].fcmToken, 'shared-device');
});

test('late unregister cannot remove a newer registration', async () => {
  const { db, users } = database();
  await bindPushToken(db, 1, 'new-token');
  await unbindPushToken(db, 1, 'shared-device');
  assert.equal(users[0].fcmToken, 'new-token');
});

test('unregister is limited to authenticated user and matching token', async () => {
  const { db, users } = database();
  await unbindPushToken(db, 2, 'shared-device');
  assert.equal(users[0].fcmToken, 'shared-device');
  await unbindPushToken(db, 1, 'shared-device');
  assert.equal(users[0].fcmToken, '');
});

test('serialization conflicts retry, permanent database errors propagate', async () => {
  const { db } = database();
  const transaction = db.$transaction;
  let attempts = 0;
  db.$transaction = async (...args) => {
    if (++attempts < 3) throw Object.assign(new Error('conflict'), { code: 'P2034' });
    return transaction(...args);
  };
  await bindPushToken(db, 2, 'shared-device');
  assert.equal(attempts, 3);
  db.$transaction = async () => { throw new Error('offline'); };
  await assert.rejects(bindPushToken(db, 2, 'token'), /offline/);
});
