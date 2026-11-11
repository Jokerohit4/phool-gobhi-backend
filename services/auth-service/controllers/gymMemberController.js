// HTTP layer for the partner's member profile. Thin: guard (partner role, owns
// the gym), parse ids, delegate to services/gymMemberService.js, shape errors.
// Owns the Prisma client so tests can inject an in-memory double.

import prisma from '../db/prisma.js';
import { assertPartnerOwnsGym } from '../services/authService.js';
import {
  getMemberProfile,
  updateMemberRecord,
  addMemberPayment,
  deleteMemberPayment,
} from '../services/gymMemberService.js';

function fail(res, err) {
  res.status(err.status || 500).json({
    error: err.error || err.message || 'Server error',
    ...(err.errorCode ? { code: err.errorCode } : {}),
    ...(err.field ? { field: err.field } : {}),
  });
}

// Every route here is a partner acting on one of their own gyms' members.
async function memberParams(req) {
  if (req.user?.role !== 'partner') throw { status: 403, error: 'Forbidden' };
  const gymId = Number.parseInt(req.params.gymId, 10);
  const userId = Number.parseInt(req.params.userId, 10);
  if (!Number.isInteger(gymId) || gymId <= 0) throw { status: 400, error: 'gymId required' };
  if (!Number.isInteger(userId) || userId <= 0) throw { status: 400, error: 'userId required' };
  await assertPartnerOwnsGym(gymId, req.user.id);
  return { gymId, userId, partnerId: req.user.id };
}

// GET /gym/:gymId/members/:userId/profile
export const getProfile = async (req, res) => {
  try {
    const { gymId, userId } = await memberParams(req);
    res.json({ data: await getMemberProfile(prisma, gymId, userId) });
  } catch (err) { fail(res, err); }
};

// PATCH /gym/:gymId/members/:userId/record — partial update; null clears a field.
export const patchRecord = async (req, res) => {
  try {
    const { gymId, userId, partnerId } = await memberParams(req);
    res.json({ data: { record: await updateMemberRecord(prisma, gymId, userId, partnerId, req.body) } });
  } catch (err) { fail(res, err); }
};

// POST /gym/:gymId/members/:userId/payments
export const postPayment = async (req, res) => {
  try {
    const { gymId, userId, partnerId } = await memberParams(req);
    res.status(201).json({ data: await addMemberPayment(prisma, gymId, userId, partnerId, req.body) });
  } catch (err) { fail(res, err); }
};

// DELETE /gym/:gymId/members/:userId/payments/:paymentId — remove a mistaken entry.
export const removePayment = async (req, res) => {
  try {
    const { gymId, userId } = await memberParams(req);
    const paymentId = Number.parseInt(req.params.paymentId, 10);
    if (!Number.isInteger(paymentId) || paymentId <= 0) return res.status(400).json({ error: 'paymentId required' });
    res.json({ data: await deleteMemberPayment(prisma, gymId, userId, paymentId) });
  } catch (err) { fail(res, err); }
};
