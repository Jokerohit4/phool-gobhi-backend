import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntranceCheckIn } from '../services/entranceCheckInService.js';

const input = { gymId: 2, customerId: 7, lat: 28.4, lng: 77.1 };
const failure = (code) => ({ status: 403, code, error: code });

test('a verified booking wins without consulting membership or creating links', async () => {
  const result = await resolveEntranceCheckIn({ ...input, confirmEarly: true }, {
    selfCheckIn: async (...args) => { assert.deepEqual(args, [2, 7, 28.4, 77.1, true]); return { bookingId: 6 }; },
    memberCheckIn: async () => assert.fail('membership must not be consulted'),
  });
  assert.deepEqual(result, { kind: 'booking', bookingId: 6 });
});

test('approved members without a booking record attendance, including repeat scans', async () => {
  const result = await resolveEntranceCheckIn(input, {
    selfCheckIn: async () => { throw failure('NO_ACTIVE_BOOKING'); },
    memberCheckIn: async () => ({ attendanceId: 9, checkedInAt: '2026-11-10T09:00:00Z', alreadyCheckedIn: true }),
  });
  assert.equal(result.kind, 'member');
  assert.equal(result.alreadyVerified, true);
  assert.equal(result.attendedAt, '2026-11-10T09:00:00Z');
});

test('claiming a booking without records grants neither membership nor attendance', async () => {
  await assert.rejects(resolveEntranceCheckIn(input, {
    selfCheckIn: async () => { throw failure('NO_ACTIVE_BOOKING'); },
    memberCheckIn: async () => { throw failure('NOT_LINKED_GYM'); },
  }), (e) => e.code === 'MEMBERSHIP_REQUIRED');
});

test('pending membership cannot record attendance', async () => {
  await assert.rejects(resolveEntranceCheckIn(input, {
    selfCheckIn: async () => { throw failure('NO_ACTIVE_BOOKING'); },
    memberCheckIn: async () => { throw failure('MEMBERSHIP_PENDING'); },
  }), (e) => e.code === 'MEMBERSHIP_PENDING');
});

for (const code of ['EARLY_CHECKIN', 'TOO_FAR', 'LOCATION_REQUIRED', 'INTERNAL_ERROR']) {
  test(`${code} never falls through to membership`, async () => {
    await assert.rejects(resolveEntranceCheckIn(input, {
      selfCheckIn: async () => { throw failure(code); },
      memberCheckIn: async () => assert.fail('must preserve booking error'),
    }), (e) => e.code === code);
  });
}

for (const code of ['BOOKING_PENDING_CONFIRMATION', 'SESSION_ENDED', 'SESSION_ALREADY_COMPLETED']) {
  test(`${code} is preserved for a visitor without membership`, async () => {
    await assert.rejects(resolveEntranceCheckIn(input, {
      selfCheckIn: async () => { throw failure(code); },
      memberCheckIn: async () => { throw failure('NOT_LINKED_GYM'); },
    }), (e) => e.code === code);
  });
}

test('invalid gym and coordinates never call check-in services', async () => {
  for (const patch of [{ gymId: -1 }, { gymId: 2.1 }, { lat: NaN }, { lng: Infinity }, { lat: 91 }]) {
    await assert.rejects(resolveEntranceCheckIn({ ...input, ...patch }, {}), (e) => e.status === 400);
  }
});
