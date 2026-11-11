// The partner's member profile: validation, the payment ledger's derived state,
// and the rule that only an approved, active member of the gym has a profile.
// Runs the real service against a small in-memory Prisma double.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePhone,
  rupeesToPaise,
  isCalendarDate,
  normalizeRecordPatch,
  normalizePayment,
  membershipStatusOf,
  summarizePayments,
  getMemberProfile,
  updateMemberRecord,
  addMemberPayment,
  deleteMemberPayment,
  rosterExtras,
} from '../services/gymMemberService.js';

// 11 Nov 2026, 11:30 IST.
const NOW = Date.UTC(2026, 10, 11, 6, 0);
const TODAY = '2026-11-11';

function matches(where, row) {
  return Object.entries(where).every(([key, cond]) => {
    if (cond !== null && typeof cond === 'object' && 'in' in cond) return cond.in.includes(row[key]);
    return row[key] === cond;
  });
}

function createFake({ users = [], gymLinks = [], records = [], payments = [] } = {}) {
  const state = {
    users: users.map((u) => ({ ...u })),
    gymLinks: gymLinks.map((l) => ({ ...l })),
    records: records.map((r) => ({ ...r })),
    payments: payments.map((p) => ({ ...p })),
  };
  let nextId = state.payments.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  const prisma = {
    user: { async findUnique({ where }) { const u = state.users.find((x) => x.id === where.id); return u ? { ...u } : null; } },
    gymLink: {
      async findFirst({ where }) { const l = state.gymLinks.find((x) => matches(where, x)); return l ? { ...l } : null; },
    },
    gymMemberRecord: {
      async findUnique({ where }) {
        const { gymId, userId } = where.gymId_userId;
        const r = state.records.find((x) => x.gymId === gymId && x.userId === userId);
        return r ? { ...r } : null;
      },
      async findMany({ where }) { return state.records.filter((x) => matches(where, x)).map((x) => ({ ...x })); },
      async upsert({ where, create, update }) {
        const { gymId, userId } = where.gymId_userId;
        const existing = state.records.find((x) => x.gymId === gymId && x.userId === userId);
        if (existing) { Object.assign(existing, update, { updatedAt: new Date(NOW) }); return { ...existing }; }
        const row = { createdAt: new Date(NOW), updatedAt: new Date(NOW), ...create };
        state.records.push(row);
        return { ...row };
      },
    },
    gymMemberPayment: {
      async findMany({ where }) { return state.payments.filter((x) => matches(where, x)).map((x) => ({ ...x })); },
      async findFirst({ where }) { const p = state.payments.find((x) => matches(where, x)); return p ? { ...p } : null; },
      async create({ data }) { const row = { id: nextId++, createdAt: new Date(NOW), ...data }; state.payments.push(row); return { ...row }; },
      async delete({ where }) { state.payments = state.payments.filter((x) => x.id !== where.id); return {}; },
    },
  };
  return { prisma, state };
}

const user = (over = {}) => ({
  id: 1, name: '  Asha Verma ', phone: '9999900000', email: 'asha@example.com', profileImageUrl: 'https://img/asha.jpg',
  gender: 'female', dateOfBirth: new Date(Date.UTC(1995, 5, 15)), fitnessGoals: ['weight_loss'], trainingTenure: 'one_to_3_years',
  createdAt: new Date(Date.UTC(2026, 0, 5)), linkedGymId: 7, gymSubscriptionEndDate: null, ...over,
});
const approvedLink = (over = {}) => ({ id: 1, userId: 1, gymId: 7, source: 'self', linkedAt: new Date(Date.UTC(2026, 9, 1)), removedAt: null, approvedAt: new Date(Date.UTC(2026, 9, 2)), firstVerifiedCheckinAt: null, ...over });
const pay = (over = {}) => ({ id: 1, gymId: 7, userId: 1, amountPaise: 150000, paidOn: '2026-10-01', paymentMode: 'upi', planName: 'Quarterly', validUntil: '2026-12-31', note: null, createdAt: new Date(NOW), ...over });

// --- validation ---------------------------------------------------------------

test('phone numbers are normalised, and nonsense is rejected', () => {
  assert.equal(normalizePhone('98765 43210'), '+919876543210');
  assert.equal(normalizePhone('098765-43210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
  assert.equal(normalizePhone('+1 (415) 555-0123'), '+14155550123');
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone(null), null);
  for (const bad of ['12345', '5876543210', 'call me', '+12']) {
    assert.throws(() => normalizePhone(bad), { status: 400, errorCode: 'INVALID_FIELD', field: 'phone' }, bad);
  }
});

test('money is whole paise, never negative, and bounded', () => {
  assert.equal(rupeesToPaise('1500.50', 'a', 'A'), 150050);
  assert.equal(rupeesToPaise(0, 'a', 'A'), 0);
  assert.equal(rupeesToPaise(1500, 'a', 'A'), 150000);
  assert.equal(rupeesToPaise('', 'a', 'A'), null);
  for (const bad of [-1, 'abc', NaN, 10.005, 10_000_001]) {
    assert.throws(() => rupeesToPaise(bad, 'amount', 'Amount'), { status: 400, field: 'amount' }, String(bad));
  }
});

test('only real calendar dates are accepted', () => {
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', 'tomorrow', '', null, 20261111]) assert.equal(isCalendarDate(bad), false, String(bad));
});

test('a record update only changes the fields sent, and null or blank clears one', () => {
  assert.deepEqual(normalizeRecordPatch({ lockerNumber: ' B-12 ' }, TODAY), { lockerNumber: 'B-12' });
  assert.deepEqual(normalizeRecordPatch({ lockerNumber: '', notes: null }, TODAY), { lockerNumber: null, notes: null });
  assert.deepEqual(normalizeRecordPatch({ amountDue: '250.5', followUpOn: '2026-11-20' }, TODAY), { amountDuePaise: 25050, followUpOn: '2026-11-20' });
});

test('a record update rejects unknown fields, empty updates and bad values', () => {
  assert.throws(() => normalizeRecordPatch({ lockerNumbr: '1' }, TODAY), { errorCode: 'UNKNOWN_FIELD', field: 'lockerNumbr' });
  assert.throws(() => normalizeRecordPatch({}, TODAY), { errorCode: 'EMPTY_UPDATE' });
  assert.throws(() => normalizeRecordPatch(null, TODAY), { errorCode: 'INVALID_BODY' });
  assert.throws(() => normalizeRecordPatch([], TODAY), { errorCode: 'INVALID_BODY' });
  assert.throws(() => normalizeRecordPatch({ joinedOn: '2026-11-12' }, TODAY), { field: 'joinedOn' }, 'not in the future');
  assert.throws(() => normalizeRecordPatch({ notes: 'x'.repeat(1001) }, TODAY), { field: 'notes' });
  assert.throws(() => normalizeRecordPatch({ lockerNumber: 'x'.repeat(21) }, TODAY), { field: 'lockerNumber' });
  assert.throws(() => normalizeRecordPatch({ lockerNumber: 12 }, TODAY), { field: 'lockerNumber' });
  assert.throws(() => normalizeRecordPatch({ emergencyContactPhone: '123' }, TODAY), { field: 'emergencyContactPhone' });
});

test('a payment needs an amount and a paid date, and keeps its dates in order', () => {
  const ok = normalizePayment({ amount: 1500, paidOn: '2026-11-01', paymentMode: ' UPI ', planName: 'Monthly', validUntil: '2026-12-01', note: 'renewal' }, TODAY);
  assert.deepEqual(ok, { amountPaise: 150000, paidOn: '2026-11-01', paymentMode: 'upi', planName: 'Monthly', validUntil: '2026-12-01', note: 'renewal' });
  assert.equal(normalizePayment({ amount: 0, paidOn: TODAY }, TODAY).amountPaise, 0, 'complimentary is allowed');
  assert.throws(() => normalizePayment({ paidOn: TODAY }, TODAY), { field: 'amount' });
  assert.throws(() => normalizePayment({ amount: 100 }, TODAY), { field: 'paidOn' });
  assert.throws(() => normalizePayment({ amount: 100, paidOn: '2026-11-12' }, TODAY), { field: 'paidOn' });
  assert.throws(() => normalizePayment({ amount: 100, paidOn: '2026-11-01', validUntil: '2026-10-31' }, TODAY), { field: 'validUntil' });
  assert.throws(() => normalizePayment({ amount: 100, paidOn: '2026-11-01', validUntil: '2099-01-01' }, TODAY), { field: 'validUntil' });
  assert.throws(() => normalizePayment({ amount: 100, paidOn: TODAY, paymentMode: 'bitcoin' }, TODAY), { field: 'paymentMode' });
  assert.throws(() => normalizePayment({ amount: 100, paidOn: TODAY, extra: 1 }, TODAY), { errorCode: 'UNKNOWN_FIELD' });
});

// --- derived membership state -------------------------------------------------

test('membership status has exact edges', () => {
  assert.deepEqual(membershipStatusOf(null, TODAY), { membershipStatus: 'none', daysToExpiry: null });
  assert.deepEqual(membershipStatusOf('2026-11-10', TODAY), { membershipStatus: 'expired', daysToExpiry: -1 });
  assert.deepEqual(membershipStatusOf('2026-11-11', TODAY), { membershipStatus: 'expiring_soon', daysToExpiry: 0 });
  assert.deepEqual(membershipStatusOf('2026-11-18', TODAY), { membershipStatus: 'expiring_soon', daysToExpiry: 7 });
  assert.deepEqual(membershipStatusOf('2026-11-19', TODAY), { membershipStatus: 'active', daysToExpiry: 8 });
});

test('validity and spend come from the whole ledger, not the latest entry', () => {
  const s = summarizePayments([
    pay({ id: 1, paidOn: '2026-01-05', amountPaise: 100000, validUntil: '2026-03-31', planName: 'Q1' }),
    pay({ id: 2, paidOn: '2026-10-01', amountPaise: 150050, validUntil: '2026-12-31', planName: 'Q4' }),
    pay({ id: 3, paidOn: '2026-11-05', amountPaise: 20000, validUntil: null, planName: 'Locker' }),
  ], TODAY);
  assert.equal(s.validUntil, '2026-12-31');
  assert.equal(s.currentPlan, 'Q4', 'the plan of the entry that sets validity, not the newest entry');
  assert.equal(s.lifetimePaid, 2700.5);
  assert.equal(s.paymentCount, 3);
  assert.equal(s.lastPaidOn, '2026-11-05');
  assert.equal(s.membershipStatus, 'active');
});

test('with no payments there is no membership state, and the total is zero', () => {
  assert.deepEqual(summarizePayments([], TODAY), {
    validUntil: null, membershipStatus: 'none', daysToExpiry: null, currentPlan: null, lifetimePaid: 0, paymentCount: 0, lastPaidOn: null,
  });
});

// --- who has a profile --------------------------------------------------------

test('only an approved, active member has a profile', async () => {
  const cases = {
    'a pending request': approvedLink({ approvedAt: null }),
    'someone the gym removed': approvedLink({ removedAt: new Date(NOW) }),
    "another gym's member": approvedLink({ gymId: 8 }),
  };
  for (const [name, link] of Object.entries(cases)) {
    const { prisma } = createFake({ users: [user()], gymLinks: [link] });
    await assert.rejects(getMemberProfile(prisma, 7, 1, { now: NOW }), { status: 404, errorCode: 'MEMBER_NOT_FOUND' }, name);
  }
  const { prisma } = createFake({ users: [user()] });
  await assert.rejects(getMemberProfile(prisma, 7, 1, { now: NOW }), { status: 404 }, 'no link at all');
});

test('a gym-QR member is approved without needing approvedAt', async () => {
  const { prisma } = createFake({ users: [user()], gymLinks: [approvedLink({ source: 'gym_qr', approvedAt: null })] });
  assert.equal((await getMemberProfile(prisma, 7, 1, { now: NOW })).customer.id, 1);
});

test('the profile shares only what a gym should see about the customer', async () => {
  const { prisma } = createFake({ users: [user()], gymLinks: [approvedLink()] });
  const p = await getMemberProfile(prisma, 7, 1, { now: NOW });
  assert.deepEqual(p.customer, {
    id: 1, name: 'Asha Verma', photoUrl: 'https://img/asha.jpg', gender: 'female', age: 31,
    fitnessGoals: ['weight_loss'], trainingTenure: 'one_to_3_years', onPlatformSince: new Date(Date.UTC(2026, 0, 5)),
  });
  // The customer's own phone, email and exact birth date never appear anywhere
  // in the payload (the `record.phone` key is the number the OWNER typed).
  const json = JSON.stringify(p);
  for (const secret of ['9999900000', 'asha@example.com', '1995-06-15']) {
    assert.ok(!json.includes(secret), `must not expose ${secret}`);
  }
  for (const key of ['phone', 'email', 'dateOfBirth', 'gymSubscriptionEndDate']) {
    assert.ok(!(key in p.customer), `customer must not carry ${key}`);
  }
  assert.equal(p.record.phone, null, 'the owner-entered number starts empty; it is not seeded from the customer');
});

test('age is exact around the birthday, and a missing photo or birth date is null', async () => {
  const at = async (dob, now) => (await getMemberProfile(createFake({ users: [user({ dateOfBirth: dob })], gymLinks: [approvedLink()] }).prisma, 7, 1, { now })).customer.age;
  const dob = new Date(Date.UTC(1995, 10, 12)); // 12 Nov
  assert.equal(await at(dob, Date.UTC(2026, 10, 11, 6, 0)), 30, 'the day before the birthday');
  assert.equal(await at(dob, Date.UTC(2026, 10, 12, 6, 0)), 31, 'on the birthday');
  assert.equal(await at(null, NOW), null);
  const { prisma } = createFake({ users: [user({ profileImageUrl: '', name: '   ', gender: null })], gymLinks: [approvedLink()] });
  const p = await getMemberProfile(prisma, 7, 1, { now: NOW });
  assert.equal(p.customer.photoUrl, null);
  assert.equal(p.customer.name, null);
  assert.equal(p.customer.gender, null);
});

test("the member's own stated end date is a hint, only while linked to this gym", async () => {
  const end = new Date(Date.UTC(2026, 11, 30, 18, 30)); // 31 Dec 00:00 IST
  const linked = createFake({ users: [user({ gymSubscriptionEndDate: end })], gymLinks: [approvedLink()] });
  assert.equal((await getMemberProfile(linked.prisma, 7, 1, { now: NOW })).statedMembershipEndsOn, '2026-12-31');
  const elsewhere = createFake({ users: [user({ gymSubscriptionEndDate: end, linkedGymId: 9 })], gymLinks: [approvedLink()] });
  assert.equal((await getMemberProfile(elsewhere.prisma, 7, 1, { now: NOW })).statedMembershipEndsOn, null);
});

test('a member with nothing recorded gets an empty record and ledger', async () => {
  const { prisma } = createFake({ users: [user()], gymLinks: [approvedLink()] });
  const p = await getMemberProfile(prisma, 7, 1, { now: NOW });
  assert.equal(p.record.lockerNumber, null);
  assert.equal(p.record.updatedAt, null);
  assert.deepEqual(p.payments, []);
  assert.equal(p.summary.membershipStatus, 'none');
});

// --- the owner's record -------------------------------------------------------

test('saving the record creates it, then later saves change only what was sent', async () => {
  const { prisma, state } = createFake({ users: [user()], gymLinks: [approvedLink()] });
  const first = await updateMemberRecord(prisma, 7, 1, 55, { phone: '98765 43210', lockerNumber: 'B-12', amountDue: 500, notes: 'prefers mornings' }, { now: NOW });
  assert.equal(first.phone, '+919876543210');
  assert.equal(first.amountDue, 500);
  const second = await updateMemberRecord(prisma, 7, 1, 55, { lockerNumber: '' , followUpOn: '2026-11-20' }, { now: NOW });
  assert.equal(second.lockerNumber, null, 'blank clears it');
  assert.equal(second.phone, '+919876543210', 'untouched fields are kept');
  assert.equal(second.notes, 'prefers mornings');
  assert.equal(second.followUpOn, '2026-11-20');
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].updatedByPartnerId, 55);
});

test('nothing can be recorded for someone who is not an approved member', async () => {
  const { prisma, state } = createFake({ users: [user()], gymLinks: [approvedLink({ approvedAt: null })] });
  await assert.rejects(updateMemberRecord(prisma, 7, 1, 55, { lockerNumber: '1' }, { now: NOW }), { status: 404 });
  await assert.rejects(addMemberPayment(prisma, 7, 1, 55, { amount: 1, paidOn: TODAY }, { now: NOW }), { status: 404 });
  assert.equal(state.records.length, 0);
  assert.equal(state.payments.length, 0);
});

// --- the ledger ---------------------------------------------------------------

test('adding a payment returns the new validity, and renewing extends it', async () => {
  const { prisma } = createFake({ users: [user()], gymLinks: [approvedLink()] });
  const a = await addMemberPayment(prisma, 7, 1, 55, { amount: 1500, paidOn: '2026-10-01', planName: 'Monthly', validUntil: '2026-10-31', paymentMode: 'cash' }, { now: NOW });
  assert.equal(a.summary.membershipStatus, 'expired');
  assert.equal(a.payment.amount, 1500);
  const b = await addMemberPayment(prisma, 7, 1, 55, { amount: 1500, paidOn: TODAY, planName: 'Monthly', validUntil: '2026-12-11' }, { now: NOW });
  assert.equal(b.summary.validUntil, '2026-12-11');
  assert.equal(b.summary.membershipStatus, 'active');
  assert.equal(b.summary.lifetimePaid, 3000);
  assert.equal(b.summary.paymentCount, 2);
});

test('the profile lists payments newest first', async () => {
  const { prisma } = createFake({
    users: [user()], gymLinks: [approvedLink()],
    payments: [pay({ id: 1, paidOn: '2026-01-05' }), pay({ id: 2, paidOn: '2026-10-01' }), pay({ id: 3, paidOn: '2026-10-01' })],
  });
  const p = await getMemberProfile(prisma, 7, 1, { now: NOW });
  assert.deepEqual(p.payments.map((x) => x.id), [3, 2, 1]);
});

test('deleting a payment recomputes validity, and only within this gym and member', async () => {
  const { prisma, state } = createFake({
    users: [user()], gymLinks: [approvedLink()],
    payments: [
      pay({ id: 1, paidOn: '2026-01-05', validUntil: '2026-03-31' }),
      pay({ id: 2, paidOn: '2026-10-01', validUntil: '2026-12-31' }),
      pay({ id: 3, gymId: 8, paidOn: '2026-10-01', validUntil: '2027-12-31' }),
      pay({ id: 4, userId: 2, paidOn: '2026-10-01', validUntil: '2027-12-31' }),
    ],
  });
  const { summary } = await deleteMemberPayment(prisma, 7, 1, 2, { now: NOW });
  assert.equal(summary.validUntil, '2026-03-31');
  assert.equal(summary.membershipStatus, 'expired');
  await assert.rejects(deleteMemberPayment(prisma, 7, 1, 3, { now: NOW }), { status: 404, errorCode: 'PAYMENT_NOT_FOUND' }, "another gym's payment");
  await assert.rejects(deleteMemberPayment(prisma, 7, 1, 4, { now: NOW }), { status: 404 }, "another member's payment");
  assert.equal(state.payments.length, 3, 'only the one payment was removed');
});

test('a member cannot accumulate unlimited payments', async () => {
  const many = Array.from({ length: 500 }, (_, i) => pay({ id: i + 1 }));
  const { prisma } = createFake({ users: [user()], gymLinks: [approvedLink()], payments: many });
  await assert.rejects(addMemberPayment(prisma, 7, 1, 55, { amount: 1, paidOn: TODAY }, { now: NOW }), { status: 409, errorCode: 'PAYMENT_LIMIT' });
});

// --- the roster's at-a-glance state -------------------------------------------

test('the roster gets expiry, follow-up, balance and locker for members who have any', async () => {
  const { prisma } = createFake({
    records: [{ gymId: 7, userId: 1, lockerNumber: 'B-12', followUpOn: '2026-11-15', amountDuePaise: 25000 }],
    payments: [pay({ id: 1, userId: 1, validUntil: '2026-11-14' }), pay({ id: 2, userId: 2, validUntil: '2027-02-01' })],
  });
  const extras = await rosterExtras(prisma, 7, [1, 2, 3], { now: NOW });
  assert.deepEqual(extras.get(1), { validUntil: '2026-11-14', membershipStatus: 'expiring_soon', daysToExpiry: 3, followUpOn: '2026-11-15', amountDue: 250, lockerNumber: 'B-12' });
  assert.equal(extras.get(2).membershipStatus, 'active');
  assert.equal(extras.get(2).lockerNumber, null);
  assert.equal(extras.has(3), false, 'nothing recorded for member 3');
  assert.equal((await rosterExtras(prisma, 7, [], { now: NOW })).size, 0);
});
