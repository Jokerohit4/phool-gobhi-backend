// OTP provider switching (fast2sms | firebase | skip) — the backend-switchable
// OTP lane both apps discover via GET /api/auth/otp-config. Covers the
// fallback-default, admin override, and the skip-allowlist phone-number
// handling. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let prisma;
class MockPrismaClient {
  constructor() {
    prisma = this;
    prisma.otpProviderSetting = { findUnique: async () => null, upsert: async () => ({}) };
    prisma.otpSkipAllowlistEntry = {
      findUnique: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      delete: async () => ({}),
    };
  }
}

let loadOtpProvider, loadOtpProviderAdmin, updateOtpProvider, isSkipAllowlisted,
  addSkipAllowlistEntry, removeSkipAllowlistEntry;

test('setup: mock @prisma/client once, import otpProviderService once', async (t) => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: MockPrismaClient } });
  ({ loadOtpProvider, loadOtpProviderAdmin, updateOtpProvider, isSkipAllowlisted,
     addSkipAllowlistEntry, removeSkipAllowlistEntry } = await import('../services/otpProviderService.js'));
  assert.equal(typeof loadOtpProvider, 'function');
});

function assertThrowsStatus(promise, status) {
  return promise.then(
    () => { throw new Error('expected throw'); },
    (err) => { assert.equal(err.status, status); return err; },
  );
}

test('loadOtpProvider: defaults to firebase when no row was ever saved', async () => {
  prisma.otpProviderSetting.findUnique = async () => null;
  assert.equal(await loadOtpProvider(), 'firebase');
  assert.equal((await loadOtpProviderAdmin()).provider, 'firebase');
  assert.equal((await loadOtpProviderAdmin()).updatedAt, null);
});

test('loadOtpProvider: returns the admin-selected provider when a row exists', async () => {
  prisma.otpProviderSetting.findUnique = async () => ({ id: 1, provider: 'fast2sms', updatedAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(await loadOtpProvider(), 'fast2sms');
  assert.deepEqual(await loadOtpProviderAdmin(), { provider: 'fast2sms', updatedAt: '2026-09-01T00:00:00.000Z' });
});

test('updateOtpProvider: persists a valid provider via upsert', async () => {
  let upsertArgs;
  prisma.otpProviderSetting.upsert = async (args) => { upsertArgs = args; return { id: 1, provider: 'skip' }; };
  await updateOtpProvider('skip', 'gobhi-1');
  assert.ok(upsertArgs);
  assert.equal(upsertArgs.where.id, 1);
  assert.equal(upsertArgs.create.provider, 'skip');
  assert.equal(upsertArgs.create.updatedBy, 'gobhi-1');
  assert.equal(upsertArgs.update.provider, 'skip');
});

test('updateOtpProvider: rejects an out-of-allowlist provider with a 400', async () => {
  let called = false;
  prisma.otpProviderSetting.upsert = async () => { called = true; };
  const err = await assertThrowsStatus(updateOtpProvider('twilio', 'gobhi-1'), 400);
  assert.match(err.error, /fast2sms, firebase, skip/);
  assert.equal(called, false, 'upsert must not run for an invalid provider');
});

test('isSkipAllowlisted: normalizes the phone before the lookup', async () => {
  let lookedUpPhone = null;
  prisma.otpSkipAllowlistEntry.findUnique = async ({ where }) => { lookedUpPhone = where.phone; return null; };
  assert.equal(await isSkipAllowlisted('+919354859197'), false);
  assert.equal(lookedUpPhone, '9354859197');
});

test('isSkipAllowlisted: short-circuits false for an empty phone', async () => {
  prisma.otpSkipAllowlistEntry.findUnique = async () => { throw new Error('must not query'); };
  assert.equal(await isSkipAllowlisted(''), false);
  assert.equal(await isSkipAllowlisted(null), false);
});

test('isSkipAllowlisted: true when the normalized number is on the list', async () => {
  prisma.otpSkipAllowlistEntry.findUnique = async () => ({ phone: '9354859197' });
  assert.equal(await isSkipAllowlisted('+91 93548 59197'), true);
});

test('addSkipAllowlistEntry: 400 for a non-10-digit normalized number', async () => {
  prisma.otpSkipAllowlistEntry.create = async () => { throw new Error('must not create'); };
  const err = await assertThrowsStatus(addSkipAllowlistEntry({ phone: '555' }), 400);
  assert.match(err.error, /10-digit/);
});

test('addSkipAllowlistEntry: persists the normalized phone and note', async () => {
  let createArgs;
  prisma.otpSkipAllowlistEntry.create = async (args) => { createArgs = args; return { id: 1 }; };
  const out = await addSkipAllowlistEntry({ phone: '+91 93548 59197', note: 'campaign tester' });
  assert.equal(createArgs.data.phone, '9354859197');
  assert.equal(createArgs.data.note, 'campaign tester');
  assert.ok(out);
});

test('addSkipAllowlistEntry: duplicate (P2002) surfaces as a 409', async () => {
  prisma.otpSkipAllowlistEntry.create = async () => { throw { code: 'P2002' }; };
  const err = await assertThrowsStatus(addSkipAllowlistEntry({ phone: '9354859197' }), 409);
  assert.match(err.error, /already on the list/);
});

test('removeSkipAllowlistEntry: prisma delete failure (P2025) becomes a 404', async () => {
  prisma.otpSkipAllowlistEntry.delete = async () => { throw { code: 'P2025' }; };
  const err = await assertThrowsStatus(removeSkipAllowlistEntry(99), 404);
  assert.match(err.error, /not found/);
});

test('removeSkipAllowlistEntry: success deletes by numeric id', async () => {
  let deleteWhere;
  prisma.otpSkipAllowlistEntry.delete = async ({ where }) => { deleteWhere = where; return {}; };
  await removeSkipAllowlistEntry('12');
  assert.equal(deleteWhere.id, 12);
});