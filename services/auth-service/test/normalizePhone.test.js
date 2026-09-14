// Covers normalizePhone — the canonical phone key for OTP lookups, User.phone
// storage, and both the OTP-store and Firebase verify paths, so "+919354859197",
// "919354859197", and "9354859197" all resolve to the same account. This is
// the user-identity boundary between the two client apps formatting phone
// differently, so getting it wrong silently splits accounts. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let normalizePhone;

test('setup: mock @prisma/client once, import normalizePhone once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {},
      Prisma: {},
    },
  });
  ({ normalizePhone } = await import('../services/authService.js'));
  assert.equal(typeof normalizePhone, 'function');
});

test('normalizePhone: returns the bare 10-digit local number', () => {
  assert.equal(normalizePhone('9354859197'), '9354859197');
  assert.equal(normalizePhone('+919354859197'), '9354859197');
  assert.equal(normalizePhone('919354859197'), '9354859197');
  assert.equal(normalizePhone('09354859197'), '9354859197');
});

test('normalizePhone: strips punctuation and whitespace', () => {
  assert.equal(normalizePhone('+91 93548 59197'), '9354859197');
  assert.equal(normalizePhone('+91-93548-59197'), '9354859197');
  assert.equal(normalizePhone('   9354859197   '), '9354859197');
});

test('normalizePhone: all valid Indian mobile first digits pass', () => {
  for (const d of ['6', '7', '8', '9']) {
    assert.equal(normalizePhone(`${d}000000000`), `${d}000000000`);
  }
});

test('normalizePhone: null for anything that is not a valid 10-digit Indian mobile', () => {
  assert.equal(normalizePhone('1234567890'), null);   // starts with 1
  assert.equal(normalizePhone('935485919'), null);    // 9 digits
  assert.equal(normalizePhone('093548591970'), null); // wrong-length 0-prefix
  assert.equal(normalizePhone('0919354859197'), null); // 13 digits
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
  assert.equal(normalizePhone('+1-555-555-5555'), null);
});