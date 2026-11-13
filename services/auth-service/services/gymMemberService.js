// A gym owner's own record of one of its members.
//
// Three layers feed the partner's member profile:
//   1. what the CUSTOMER shares by being a member (name, photo, gender, age,
//      goals) — read from the User row, never edited here, never the phone, email
//      or exact date of birth;
//   2. what the OWNER records (GymMemberRecord): the number to call, locker,
//      emergency contact, their own join date, a follow-up reminder, balance due
//      and notes;
//   3. the owner's payment ledger (GymMemberPayment). Members renew, so each
//      payment is its own row and "valid until" / lifetime paid are derived from
//      the ledger rather than overwritten.
// (Visit patterns come from booking-service, which owns attendance.)
//
// Only an approved, active member of this gym has a profile here — a pending
// request or someone the gym removed answers 404, so this can never be used to
// read people who are not (yet) the gym's members.
//
// Dates are IST calendar dates ('YYYY-MM-DD'); money is stored in paise and
// exposed in rupees. Prisma is injected so tests run against an in-memory double.

import { gymLinkStatus } from '../utils/gymLinkStatus.js';

const IST_OFFSET_MS = (5 * 60 + 30) * 60000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'];
// A renewal reminder, not a hard rule: this is when the profile starts to flag it.
export const EXPIRING_SOON_DAYS = 7;
const MAX_AMOUNT_RUPEES = 10_000_000;
const MAX_PAYMENTS_PER_MEMBER = 500;
const PROFILE_PAYMENTS_SHOWN = 100;
const MAX_VALIDITY_YEARS = 10;

const RECORD_FIELDS = ['phone', 'emergencyContactName', 'emergencyContactPhone', 'lockerNumber', 'joinedOn', 'followUpOn', 'amountDue', 'notes'];
const PAYMENT_FIELDS = ['amount', 'paidOn', 'paymentMode', 'planName', 'validUntil', 'note'];

function invalid(field, error, errorCode = 'INVALID_FIELD') {
  return { status: 400, error, errorCode, field };
}

export function todayIST(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function dateMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function daysBetween(from, to) {
  return Math.round((dateMs(to) - dateMs(from)) / MS_PER_DAY);
}

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function text(value, max, field, label) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw invalid(field, `${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(field, `${label} can be at most ${max} characters`);
  return trimmed;
}

// A number the owner typed. Ten-digit Indian numbers are stored as +91…; anything
// else must already be international (+…). Separators are dropped.
export function normalizePhone(value, field = 'phone', label = 'Phone number') {
  if (isBlank(value)) return null;
  const raw = String(value).replace(/[\s\-().]/g, '');
  if (/^\+\d{8,15}$/.test(raw)) return raw;
  if (/^[6-9]\d{9}$/.test(raw)) return `+91${raw}`;
  if (/^0[6-9]\d{9}$/.test(raw)) return `+91${raw.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(raw)) return `+${raw}`;
  throw invalid(field, `${label} should be a valid number, like 98765 43210`);
}

function date(value, field, label) {
  if (isBlank(value)) return null;
  if (!isCalendarDate(value)) throw invalid(field, `${label} should be a date like 2026-11-30`);
  return value;
}

export function rupeesToPaise(value, field, label) {
  if (isBlank(value)) return null;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw invalid(field, `${label} should be a number`);
  if (n < 0) throw invalid(field, `${label} cannot be negative`);
  if (n > MAX_AMOUNT_RUPEES) throw invalid(field, `${label} is too large`);
  const paise = Math.round(n * 100);
  if (Math.abs(paise - n * 100) > 1e-6) throw invalid(field, `${label} can have at most two decimal places`);
  return paise;
}

const toRupees = (paise) => (paise == null ? null : paise / 100);

function rejectUnknown(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid(null, 'A JSON object is required', 'INVALID_BODY');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid(key, `Unknown field "${key}"`, 'UNKNOWN_FIELD');
  }
}

/**
 * Validate a partial update of the owner's record. Only keys present are
 * changed; null or a blank string clears one. Returns column-ready data.
 */
export function normalizeRecordPatch(body, today = todayIST()) {
  rejectUnknown(body, RECORD_FIELDS);
  const data = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (has('phone')) data.phone = normalizePhone(body.phone, 'phone', 'Phone number');
  if (has('emergencyContactPhone')) data.emergencyContactPhone = normalizePhone(body.emergencyContactPhone, 'emergencyContactPhone', 'Emergency contact number');
  if (has('emergencyContactName')) data.emergencyContactName = text(body.emergencyContactName, 80, 'emergencyContactName', 'Emergency contact name');
  if (has('lockerNumber')) data.lockerNumber = text(body.lockerNumber, 20, 'lockerNumber', 'Locker number');
  if (has('notes')) data.notes = text(body.notes, 1000, 'notes', 'Notes');
  if (has('joinedOn')) {
    data.joinedOn = date(body.joinedOn, 'joinedOn', 'Join date');
    if (data.joinedOn && data.joinedOn > today) throw invalid('joinedOn', 'Join date cannot be in the future');
  }
  if (has('followUpOn')) data.followUpOn = date(body.followUpOn, 'followUpOn', 'Follow-up date');
  if (has('amountDue')) data.amountDuePaise = rupeesToPaise(body.amountDue, 'amountDue', 'Amount due');
  if (!Object.keys(data).length) throw invalid(null, 'Nothing to update', 'EMPTY_UPDATE');
  return data;
}

function addYears(isoDate, years) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/** Validate a new payment. Amount and paid date are required; the rest optional. */
export function normalizePayment(body, today = todayIST()) {
  rejectUnknown(body, PAYMENT_FIELDS);
  if (isBlank(body.amount)) throw invalid('amount', 'Enter the amount paid (0 if it was complimentary)');
  const amountPaise = rupeesToPaise(body.amount, 'amount', 'Amount');
  if (isBlank(body.paidOn)) throw invalid('paidOn', 'Enter the date it was paid');
  const paidOn = date(body.paidOn, 'paidOn', 'Paid date');
  if (paidOn > today) throw invalid('paidOn', 'Paid date cannot be in the future');

  let paymentMode = null;
  if (!isBlank(body.paymentMode)) {
    paymentMode = String(body.paymentMode).trim().toLowerCase();
    if (!PAYMENT_MODES.includes(paymentMode)) throw invalid('paymentMode', `Payment mode must be one of: ${PAYMENT_MODES.join(', ')}`);
  }
  const validUntil = date(body.validUntil, 'validUntil', 'Valid-until date');
  if (validUntil) {
    if (validUntil < paidOn) throw invalid('validUntil', 'Valid-until date cannot be before the paid date');
    if (validUntil > addYears(today, MAX_VALIDITY_YEARS)) throw invalid('validUntil', 'Valid-until date looks too far ahead — check the year');
  }
  return {
    amountPaise,
    paidOn,
    paymentMode,
    planName: text(body.planName, 60, 'planName', 'Plan name'),
    validUntil,
    note: text(body.note, 200, 'note', 'Note'),
  };
}

export function membershipStatusOf(validUntil, today) {
  if (!validUntil) return { membershipStatus: 'none', daysToExpiry: null };
  const daysToExpiry = daysBetween(today, validUntil);
  if (daysToExpiry < 0) return { membershipStatus: 'expired', daysToExpiry };
  return { membershipStatus: daysToExpiry <= EXPIRING_SOON_DAYS ? 'expiring_soon' : 'active', daysToExpiry };
}

// Newest first: by paid date, then by entry order.
const newestFirst = (a, b) => (a.paidOn === b.paidOn ? b.id - a.id : a.paidOn < b.paidOn ? 1 : -1);

/** Membership validity and spend, derived from the whole ledger. */
export function summarizePayments(payments, today) {
  let validUntil = null;
  let current = null;
  let lastPaidOn = null;
  let totalPaise = 0;
  for (const p of payments) {
    totalPaise += p.amountPaise;
    if (!lastPaidOn || p.paidOn > lastPaidOn) lastPaidOn = p.paidOn;
    if (p.validUntil && (!validUntil || p.validUntil > validUntil || (p.validUntil === validUntil && newestFirst(p, current) < 0))) {
      validUntil = p.validUntil;
      current = p;
    }
  }
  return {
    validUntil,
    ...membershipStatusOf(validUntil, today),
    currentPlan: current?.planName ?? null,
    lifetimePaid: toRupees(totalPaise),
    paymentCount: payments.length,
    lastPaidOn,
  };
}

export const shapePayment = (p) => ({
  id: p.id,
  amount: toRupees(p.amountPaise),
  paidOn: p.paidOn,
  paymentMode: p.paymentMode ?? null,
  planName: p.planName ?? null,
  validUntil: p.validUntil ?? null,
  note: p.note ?? null,
  createdAt: p.createdAt ?? null,
});

const EMPTY_RECORD = {
  phone: null, emergencyContactName: null, emergencyContactPhone: null, lockerNumber: null,
  joinedOn: null, followUpOn: null, amountDue: null, notes: null, updatedAt: null,
};

export const shapeRecord = (row) => (row ? {
  phone: row.phone ?? null,
  emergencyContactName: row.emergencyContactName ?? null,
  emergencyContactPhone: row.emergencyContactPhone ?? null,
  lockerNumber: row.lockerNumber ?? null,
  joinedOn: row.joinedOn ?? null,
  followUpOn: row.followUpOn ?? null,
  amountDue: toRupees(row.amountDuePaise),
  notes: row.notes ?? null,
  updatedAt: row.updatedAt ?? null,
} : { ...EMPTY_RECORD });

function ageOf(dateOfBirth, today) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - dob.getUTCFullYear();
  if (tm < dob.getUTCMonth() + 1 || (tm === dob.getUTCMonth() + 1 && td < dob.getUTCDate())) age -= 1;
  return age >= 10 && age <= 110 ? age : null;
}

const istDateOf = (instant) => (instant ? new Date(new Date(instant).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) : null);

/** The member's active link to this gym, but only if the gym has approved it. */
export async function assertApprovedMember(prisma, gymId, userId) {
  const link = await prisma.gymLink.findFirst({ where: { userId, gymId, removedAt: null }, orderBy: { linkedAt: 'desc' } });
  if (!link || gymLinkStatus(link) !== 'approved') {
    throw { status: 404, error: 'Member not found', errorCode: 'MEMBER_NOT_FOUND' };
  }
  return link;
}

/**
 * The whole profile in one read: what the customer shares, the owner's record,
 * the payment ledger and its summary.
 */
export async function getMemberProfile(prisma, gymId, userId, { now = Date.now() } = {}) {
  const link = await assertApprovedMember(prisma, gymId, userId);
  const today = todayIST(now);
  const [user, record, payments] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.gymMemberRecord.findUnique({ where: { gymId_userId: { gymId, userId } } }),
    prisma.gymMemberPayment.findMany({ where: { gymId, userId } }),
  ]);
  if (!user) throw { status: 404, error: 'Member not found', errorCode: 'MEMBER_NOT_FOUND' };
  const ordered = [...payments].sort(newestFirst);
  return {
    customer: {
      id: user.id,
      name: typeof user.name === 'string' && user.name.trim() ? user.name.trim() : null,
      photoUrl: user.profileImageUrl ? user.profileImageUrl : null,
      gender: user.gender ?? null,
      age: ageOf(user.dateOfBirth, today),
      fitnessGoals: Array.isArray(user.fitnessGoals) ? user.fitnessGoals : [],
      trainingTenure: user.trainingTenure ?? null,
      onPlatformSince: user.createdAt ?? null,
    },
    link: {
      source: link.source,
      linkedAt: link.linkedAt,
      approvedAt: link.approvedAt ?? null,
      firstVerifiedCheckinAt: link.firstVerifiedCheckinAt ?? null,
    },
    record: shapeRecord(record),
    payments: ordered.slice(0, PROFILE_PAYMENTS_SHOWN).map(shapePayment),
    summary: summarizePayments(payments, today),
    // The member's own answer to "when does your gym membership end", from
    // onboarding. Offered as a hint when the owner fills in "valid until"; it is
    // never treated as the gym's record.
    statedMembershipEndsOn: user.linkedGymId === gymId ? istDateOf(user.gymSubscriptionEndDate) : null,
  };
}

export async function updateMemberRecord(prisma, gymId, userId, partnerId, body, { now = Date.now() } = {}) {
  await assertApprovedMember(prisma, gymId, userId);
  const data = normalizeRecordPatch(body, todayIST(now));
  const row = await prisma.gymMemberRecord.upsert({
    where: { gymId_userId: { gymId, userId } },
    create: { gymId, userId, ...data, updatedByPartnerId: partnerId },
    update: { ...data, updatedByPartnerId: partnerId },
  });
  return shapeRecord(row);
}

export async function addMemberPayment(prisma, gymId, userId, partnerId, body, { now = Date.now() } = {}) {
  await assertApprovedMember(prisma, gymId, userId);
  const today = todayIST(now);
  const data = normalizePayment(body, today);
  const existing = await prisma.gymMemberPayment.findMany({ where: { gymId, userId } });
  if (existing.length >= MAX_PAYMENTS_PER_MEMBER) {
    throw { status: 409, error: 'This member has too many payments recorded', errorCode: 'PAYMENT_LIMIT' };
  }
  const created = await prisma.gymMemberPayment.create({ data: { gymId, userId, ...data, createdByPartnerId: partnerId } });
  return { payment: shapePayment(created), summary: summarizePayments([...existing, created], today) };
}

/** Remove a mistaken entry. The payment must belong to this gym's member. */
export async function deleteMemberPayment(prisma, gymId, userId, paymentId, { now = Date.now() } = {}) {
  await assertApprovedMember(prisma, gymId, userId);
  const payment = await prisma.gymMemberPayment.findFirst({ where: { id: paymentId, gymId, userId } });
  if (!payment) throw { status: 404, error: 'Payment not found', errorCode: 'PAYMENT_NOT_FOUND' };
  await prisma.gymMemberPayment.delete({ where: { id: payment.id } });
  const remaining = await prisma.gymMemberPayment.findMany({ where: { gymId, userId } });
  return { summary: summarizePayments(remaining, todayIST(now)) };
}

/**
 * What the roster row shows at a glance, for many members in two queries:
 * expiry state from the ledger, plus follow-up, balance due and locker.
 * Members with nothing recorded are simply absent from the map.
 */
export async function rosterExtras(prisma, gymId, userIds, { now = Date.now() } = {}) {
  if (!userIds.length) return new Map();
  const today = todayIST(now);
  const [records, payments] = await Promise.all([
    prisma.gymMemberRecord.findMany({ where: { gymId, userId: { in: userIds } } }),
    prisma.gymMemberPayment.findMany({ where: { gymId, userId: { in: userIds } } }),
  ]);
  const paymentsBy = new Map();
  for (const p of payments) {
    if (!paymentsBy.has(p.userId)) paymentsBy.set(p.userId, []);
    paymentsBy.get(p.userId).push(p);
  }
  const recordBy = new Map(records.map((r) => [r.userId, r]));
  const out = new Map();
  for (const id of new Set([...recordBy.keys(), ...paymentsBy.keys()])) {
    const summary = summarizePayments(paymentsBy.get(id) ?? [], today);
    const r = recordBy.get(id);
    out.set(id, {
      validUntil: summary.validUntil,
      membershipStatus: summary.membershipStatus,
      daysToExpiry: summary.daysToExpiry,
      followUpOn: r?.followUpOn ?? null,
      amountDue: toRupees(r?.amountDuePaise ?? null),
      lockerNumber: r?.lockerNumber ?? null,
    });
  }
  return out;
}
