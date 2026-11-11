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

const noBooking = async () => { throw failure('NO_ACTIVE_BOOKING'); };
const noJoinDeps = {
  assertAtGym: async () => assert.fail('must not verify presence without join'),
  joinGymViaQr: async () => assert.fail('must not link without join'),
};
const memberRecord = { attendanceId: 4, checkedInAt: '2026-11-11T09:00:00Z', alreadyCheckedIn: false };

test('a scan without join never links: a stranger is asked to join first', async () => {
  await assert.rejects(resolveEntranceCheckIn(input, {
    ...noJoinDeps, selfCheckIn: noBooking,
    memberCheckIn: async () => { throw failure('NOT_LINKED_GYM'); },
  }), (e) => e.code === 'MEMBERSHIP_REQUIRED');
});

test('someone already waiting for approval is told so, not asked to join again', async () => {
  await assert.rejects(resolveEntranceCheckIn(input, {
    ...noJoinDeps, selfCheckIn: noBooking,
    memberCheckIn: async () => { throw failure('MEMBERSHIP_PENDING'); },
  }), (e) => e.code === 'MEMBERSHIP_PENDING');
});

test('join with the owner window open: presence, link, then attendance — in that order', async () => {
  const calls = [];
  let linked = false;
  const result = await resolveEntranceCheckIn({ ...input, join: true }, {
    selfCheckIn: noBooking,
    memberCheckIn: async () => {
      calls.push('member');
      if (!linked) throw failure('NOT_LINKED_GYM');
      return memberRecord;
    },
    assertAtGym: async (...args) => { assert.deepEqual(args, [2, 28.4, 77.1]); calls.push('presence'); },
    joinGymViaQr: async (...args) => {
      assert.deepEqual(args, [7, 2]); calls.push('join'); linked = true;
      return { status: 'approved', joined: true, requested: false };
    },
  });
  assert.deepEqual(calls, ['member', 'presence', 'join', 'member']);
  assert.equal(result.kind, 'member');
  assert.equal(result.joined, true);
});

test('join with the window closed leaves a pending request and records no attendance', async () => {
  let memberCalls = 0;
  await assert.rejects(resolveEntranceCheckIn({ ...input, join: true }, {
    selfCheckIn: noBooking,
    memberCheckIn: async () => { memberCalls += 1; throw failure('NOT_LINKED_GYM'); },
    assertAtGym: async () => {},
    joinGymViaQr: async () => ({ status: 'pending', joined: true, requested: true }),
  }), (e) => e.code === 'MEMBERSHIP_PENDING');
  assert.equal(memberCalls, 1, 'attendance must not be attempted for an unapproved request');
});

test('an open window approves a request that was already waiting, then checks in', async () => {
  let approved = false;
  const result = await resolveEntranceCheckIn({ ...input, join: true }, {
    selfCheckIn: noBooking,
    memberCheckIn: async () => {
      if (!approved) throw failure('MEMBERSHIP_PENDING');
      return memberRecord;
    },
    assertAtGym: async () => {},
    joinGymViaQr: async () => { approved = true; return { status: 'approved', joined: false, requested: false }; },
  });
  assert.equal(result.kind, 'member');
  assert.equal(result.joined, false, 'they had already asked, so this is not a fresh join');
});

test('a failed presence check links nobody', async () => {
  await assert.rejects(resolveEntranceCheckIn({ ...input, join: true }, {
    selfCheckIn: noBooking,
    memberCheckIn: async () => { throw failure('NOT_LINKED_GYM'); },
    assertAtGym: async () => { throw { status: 400, code: 'TOO_FAR' }; },
    joinGymViaQr: async () => assert.fail('presence failed, so nothing may be linked'),
  }), (e) => e.code === 'TOO_FAR');
});

for (const code of ['ALREADY_LINKED', 'MEMBERSHIP_BLOCKED', 'GYM_UNAVAILABLE', 'SELF_LINK_LIMIT']) {
  test(`join surfaces ${code} from the link rules and records no attendance`, async () => {
    let memberCalls = 0;
    await assert.rejects(resolveEntranceCheckIn({ ...input, join: true }, {
      selfCheckIn: noBooking,
      memberCheckIn: async () => { memberCalls += 1; throw failure('NOT_LINKED_GYM'); },
      assertAtGym: async () => {},
      joinGymViaQr: async () => { throw { status: 409, code }; },
    }), (e) => e.code === code);
    assert.equal(memberCalls, 1);
  });
}

test('join never overrides a booking: a booked guest is not asked to become a member', async () => {
  await assert.rejects(resolveEntranceCheckIn({ ...input, join: true }, {
    ...noJoinDeps,
    selfCheckIn: async () => { throw failure('BOOKING_PENDING_CONFIRMATION'); },
    memberCheckIn: async () => { throw failure('NOT_LINKED_GYM'); },
  }), (e) => e.code === 'BOOKING_PENDING_CONFIRMATION');
});

test('an existing member or booking never triggers a join even when join is sent', async () => {
  const member = await resolveEntranceCheckIn({ ...input, join: true }, {
    ...noJoinDeps, selfCheckIn: noBooking,
    memberCheckIn: async () => ({ attendanceId: 1, checkedInAt: 't', alreadyCheckedIn: true }),
  });
  assert.equal(member.joined, false);
  const booking = await resolveEntranceCheckIn({ ...input, join: true }, {
    ...noJoinDeps, selfCheckIn: async () => ({ bookingId: 3 }),
    memberCheckIn: async () => assert.fail('booking wins'),
  });
  assert.equal(booking.kind, 'booking');
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
