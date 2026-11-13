// Closing an account by ARCHIVING it (the default deletion mode): the person is
// neutralised in place and disappears from everyone else's view, but NOTHING is
// deleted — and signing in again with the same number makes a brand-new user.
// Run with: node --experimental-test-module-mocks --test test/accountArchive.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archiveUserAccount, identitySnapshot, ARCHIVED_DISPLAY_NAME } from '../services/accountArchiveService.js';

const NOW = new Date('2026-11-11T06:00:00Z');

const liveUser = (over = {}) => ({
  id: 42, name: 'Asha Verma', phone: '+919876543210', email: 'asha@example.com', profileImageUrl: 'https://img/asha.jpg',
  fcmToken: 'fcm-token-1', referralCode: 'ASHA42', isActive: true, leaderboardOptIn: true, linkedGymId: 7, archivedAt: null,
  // Things that must be left exactly as they are.
  gender: 'female', dateOfBirth: new Date('1995-06-15'), fitnessGoals: ['weight_loss'], trainingTenure: 'one_to_3_years',
  role: 'customer', type: 'general', createdAt: new Date('2026-01-05'),
  ...over,
});

// A Prisma double that records every write and FAILS on any model or method the
// archive is not supposed to use — a stray delete is a test failure, not a no-op.
function createFake(user, { links = [], tokens = [] } = {}) {
  const state = { user: { ...user }, links: links.map((l) => ({ ...l })), tokens: tokens.map((t) => ({ ...t })), writes: [] };
  const allowed = {
    user: {
      update: async ({ where, data }) => {
        state.writes.push('user.update');
        assert.equal(where.id, state.user.id);
        Object.assign(state.user, data);
        return { ...state.user };
      },
    },
    gymLink: {
      updateMany: async ({ where, data }) => {
        state.writes.push('gymLink.updateMany');
        const hit = state.links.filter((l) => l.userId === where.userId && l.removedAt === null);
        hit.forEach((l) => Object.assign(l, data));
        return { count: hit.length };
      },
    },
    refreshToken: {
      deleteMany: async ({ where }) => {
        state.writes.push('refreshToken.deleteMany');
        const before = state.tokens.length;
        state.tokens = state.tokens.filter((t) => t.userId !== where.userId);
        return { count: before - state.tokens.length };
      },
    },
  };
  const prisma = new Proxy({}, {
    get(_t, prop) {
      if (prop === '$transaction') return async (ops) => Promise.all(ops);
      if (!allowed[prop]) throw new Error(`archive must not touch ${String(prop)}`);
      return new Proxy(allowed[prop], {
        get(target, method) {
          if (!target[method]) throw new Error(`archive must not call ${String(prop)}.${String(method)}`);
          return target[method];
        },
      });
    },
  });
  return { prisma, state };
}

test('the identifying fields move into the retained snapshot, exactly as they were', () => {
  assert.deepEqual(identitySnapshot(liveUser(), NOW), {
    name: 'Asha Verma', phone: '+919876543210', email: 'asha@example.com', profileImageUrl: 'https://img/asha.jpg',
    fcmToken: 'fcm-token-1', referralCode: 'ASHA42', archivedAt: NOW.toISOString(),
  });
});

test('archiving neutralises the live identity so nothing can show or find the person', async () => {
  const { prisma, state } = createFake(liveUser());
  assert.equal(await archiveUserAccount(prisma, liveUser(), { now: NOW }), true);
  const u = state.user;
  assert.equal(u.name, ARCHIVED_DISPLAY_NAME);
  assert.equal(u.phone, null);
  assert.equal(u.email, null);
  assert.equal(u.profileImageUrl, '');
  assert.equal(u.fcmToken, '');
  assert.equal(u.referralCode, null);
  assert.equal(u.isActive, false, 'login and refresh both refuse an inactive account');
  assert.equal(u.leaderboardOptIn, false);
  assert.equal(u.linkedGymId, null);
  assert.deepEqual(u.archivedAt, NOW);
});

test('the original identity is retained in the snapshot, not lost', async () => {
  const { prisma, state } = createFake(liveUser());
  await archiveUserAccount(prisma, liveUser(), { now: NOW });
  assert.equal(state.user.archivedData.phone, '+919876543210');
  assert.equal(state.user.archivedData.email, 'asha@example.com');
  assert.equal(state.user.archivedData.name, 'Asha Verma');
  assert.equal(state.user.archivedData.profileImageUrl, 'https://img/asha.jpg');
});

test('everything else on the account is left exactly as it was', async () => {
  const { prisma, state } = createFake(liveUser());
  await archiveUserAccount(prisma, liveUser(), { now: NOW });
  const u = state.user;
  assert.equal(u.gender, 'female');
  assert.deepEqual(u.dateOfBirth, new Date('1995-06-15'));
  assert.deepEqual(u.fitnessGoals, ['weight_loss']);
  assert.equal(u.trainingTenure, 'one_to_3_years');
  assert.equal(u.role, 'customer');
  assert.deepEqual(u.createdAt, new Date('2026-01-05'));
  assert.equal(u.id, 42, 'the id is kept: the retained data still points at this row');
});

test('it deletes nothing: only the user row, the membership link and the sessions are written', async () => {
  const { prisma, state } = createFake(liveUser());
  // The double throws on any other model or method (savedAddress, partnerBankAccount,
  // gymMemberRecord, gymMemberPayment, userDevice, appModeHistory, user.delete, ...).
  await archiveUserAccount(prisma, liveUser(), { now: NOW });
  assert.deepEqual(state.writes.sort(), ['gymLink.updateMany', 'refreshToken.deleteMany', 'user.update']);
});

test('memberships end but the link rows stay on record, and only this user is affected', async () => {
  const { prisma, state } = createFake(liveUser(), {
    links: [
      { id: 1, userId: 42, gymId: 7, removedAt: null },
      { id: 2, userId: 42, gymId: 3, removedAt: new Date('2026-02-01') },
      { id: 3, userId: 99, gymId: 7, removedAt: null },
    ],
  });
  await archiveUserAccount(prisma, liveUser(), { now: NOW });
  assert.equal(state.links.length, 3, 'no link row is deleted');
  assert.deepEqual(state.links[0].removedAt, NOW, 'the live membership ended');
  assert.deepEqual(state.links[1].removedAt, new Date('2026-02-01'), 'an earlier end date is not overwritten');
  assert.equal(state.links[2].removedAt, null, "another member's link is untouched");
});

test("sessions are revoked, for this user only, so the old account can't be resumed", async () => {
  const { prisma, state } = createFake(liveUser(), { tokens: [{ id: 1, userId: 42 }, { id: 2, userId: 42 }, { id: 3, userId: 99 }] });
  await archiveUserAccount(prisma, liveUser(), { now: NOW });
  assert.deepEqual(state.tokens.map((t) => t.id), [3]);
});

test('archiving twice is a no-op that never overwrites the snapshot with the neutral values', async () => {
  const { prisma, state } = createFake(liveUser());
  await archiveUserAccount(prisma, liveUser(), { now: NOW });
  const snapshot = JSON.stringify(state.user.archivedData);
  const writesAfterFirst = state.writes.length;
  assert.equal(await archiveUserAccount(prisma, { ...state.user }, { now: new Date('2027-01-01') }), false);
  assert.equal(JSON.stringify(state.user.archivedData), snapshot);
  assert.equal(state.writes.length, writesAfterFirst, 'no further writes');
});

test('the phone and email are free afterwards, so the same number can sign up as a new user', async () => {
  const { prisma, state } = createFake(liveUser());
  await archiveUserAccount(prisma, liveUser(), { now: NOW });
  // A unique index on phone/email allows many nulls, so a new account may take them.
  assert.equal(state.user.phone, null);
  assert.equal(state.user.email, null);
  assert.equal(state.user.referralCode, null, 'and nobody can apply the archived account\'s referral code');
});

// --- deleteUserService orchestration ------------------------------------------

let archiveCalls;
let eraseCalls;
let archiveResult;
let dbUser;
let userUpdates;
let deleteUserService;
let accountDeletionMode;

test('setup: mock prisma and both fan-outs, import the service once', async (t) => {
  delete process.env.ACCOUNT_DELETION_MODE;
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          return new Proxy({}, {
            get(_target, prop) {
              if (prop === '$transaction') return async (ops) => Promise.all(ops);
              if (prop === 'user') {
                return {
                  findUnique: async () => (dbUser ? { ...dbUser } : null),
                  update: async ({ data }) => { userUpdates.push(data); return {}; },
                  delete: async () => { throw new Error('archive mode must never delete the user row'); },
                };
              }
              if (prop === 'gymLink') return { updateMany: async () => ({ count: 0 }) };
              if (prop === 'refreshToken') return { deleteMany: async () => ({ count: 0 }) };
              if (typeof prop === 'string' && !prop.startsWith('$')) {
                return new Proxy({}, { get(_t, method) { return () => { throw new Error(`archive mode must not call ${prop}.${String(method)}`); }; } });
              }
              return undefined;
            },
          });
        }
      },
      Prisma: {},
    },
  });
  t.mock.module('../utils/archiveAcrossServices.js', {
    exports: { archiveUserAcrossServices: async (id) => { archiveCalls.push(id); return archiveResult; } },
  });
  t.mock.module('../utils/eraseAcrossServices.js', {
    exports: { eraseUserAcrossServices: async (id) => { eraseCalls.push(id); return { ok: true, results: [], failures: [] }; } },
  });
  ({ deleteUserService, accountDeletionMode } = await import('../services/authService.js'));
});

function resetOrchestration() {
  delete process.env.ACCOUNT_DELETION_MODE;
  archiveCalls = [];
  eraseCalls = [];
  userUpdates = [];
  archiveResult = { ok: true, results: [{ service: 'buddy-service', archived: true }], failures: [] };
  dbUser = liveUser();
}

test('archive is the default mode, and only an explicit "erase" restores hard deletion', () => {
  delete process.env.ACCOUNT_DELETION_MODE;
  assert.equal(accountDeletionMode(), 'archive');
  process.env.ACCOUNT_DELETION_MODE = 'erase';
  assert.equal(accountDeletionMode(), 'erase');
  process.env.ACCOUNT_DELETION_MODE = ' ERASE ';
  assert.equal(accountDeletionMode(), 'erase');
  for (const odd of ['', 'delete', 'archive', 'nonsense']) {
    process.env.ACCOUNT_DELETION_MODE = odd;
    assert.equal(accountDeletionMode(), 'archive', `"${odd}" must not silently enable hard deletion`);
  }
  delete process.env.ACCOUNT_DELETION_MODE;
});

test('deleting an account hides the person from others first, then neutralises the account, and erases nothing', async () => {
  resetOrchestration();
  const result = await deleteUserService(42);
  assert.deepEqual(result, { message: 'User deleted', archived: true });
  assert.deepEqual(archiveCalls, [42], 'buddy-service is asked to hide them');
  assert.deepEqual(eraseCalls, [], 'the erase fan-out must not run in archive mode');
  assert.equal(userUpdates.length, 1);
  assert.equal(userUpdates[0].phone, null);
  assert.equal(userUpdates[0].name, ARCHIVED_DISPLAY_NAME);
});

test('if hiding them fails, the account is left exactly as it was and the user can retry', async () => {
  resetOrchestration();
  archiveResult = { ok: false, results: [], failures: [{ service: 'buddy-service', status: 500, error: 'down' }] };
  await assert.rejects(deleteUserService(42), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.errorCode, 'ARCHIVE_INCOMPLETE');
    assert.deepEqual(err.failedServices, ['buddy-service']);
    return true;
  });
  assert.equal(userUpdates.length, 0, "the identity must not be neutralised while their profile is still visible");
});

test('an account that is already archived answers success without doing anything again', async () => {
  resetOrchestration();
  dbUser = liveUser({ archivedAt: NOW });
  assert.deepEqual(await deleteUserService(42), { message: 'User deleted', archived: true });
  assert.deepEqual(archiveCalls, []);
  assert.equal(userUpdates.length, 0);
});

test('an unknown account is a clear 404', async () => {
  resetOrchestration();
  dbUser = null;
  await assert.rejects(deleteUserService(42), { status: 404, errorCode: 'USER_NOT_FOUND' });
});
