import { payRoutineClaims, retryRoutineWorkouts, recordRoutineWater } from '../services/routineJourneyService.js';
import { PrismaClient } from '@prisma/client';
import * as habitsService from '../services/habitsService.js';

const prisma = new PrismaClient();

// Thin adapter over habitsService, same shape as the ledger and coach-consent
// controllers: parse, delegate, wrap errors. The rules (bounds, formats, the
// cap) live in the service, because a rule enforced in a controller is a rule
// the next controller forgets.
//
// Status codes are explicit per the Contracts, which is why these handlers do
// not share the plain handle() helper that always answers 200:
//
//   GET  /habits/today                 200 {data:{water,supplements}}
//   POST /habits/water                 201 {data:{id,loggedMl}}
//   DELETE /habits/water/:id           204
//   GET  /habits/supplements           200 {data:[rows]}
//   POST /habits/supplements           201 {data:row}
//   PUT  /habits/supplements/:id       200 {data:row}
//   DELETE /habits/supplements/:id     204
//   POST /habits/supplements/:id/taken 201 {data:log}

function fail(res, err, tag) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[${tag}]`, err);
  return res.status(status).json({
    error: err.error || err.message || 'Server error',
    code: err.code,
  });
}

export const getToday = async (req, res) => {
  try {
    const data = await habitsService.getToday(prisma, {
      userId: req.userId,
      localDate: req.query?.localDate,
    });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const logWater = async (req, res) => {
  try {
    const data = await habitsService.logWater(prisma, {
      userId: req.userId,
      ml: req.body?.ml,
      requestId: req.body?.requestId,
      localDate: req.body?.localDate,
    });
    return res.status(201).json({ data });
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const deleteWaterLog = async (req, res) => {
  try {
    await habitsService.deleteWaterLog(prisma, { userId: req.userId, id: req.params.id });
    return res.status(204).end();
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const listSupplements = async (req, res) => {
  try {
    const data = await habitsService.listSupplements(prisma, { userId: req.userId });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const createSupplement = async (req, res) => {
  try {
    const data = await habitsService.createSupplement(prisma, {
      userId: req.userId,
      name: req.body?.name,
      times: req.body?.times,
    });
    return res.status(201).json({ data });
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const updateSupplement = async (req, res) => {
  try {
    const data = await habitsService.updateSupplement(prisma, {
      userId: req.userId,
      id: req.params.id,
      name: req.body?.name,
      times: req.body?.times,
    });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const deleteSupplement = async (req, res) => {
  try {
    await habitsService.deleteSupplement(prisma, { userId: req.userId, id: req.params.id });
    return res.status(204).end();
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const markTaken = async (req, res) => {
  try {
    const data = await habitsService.markTaken(prisma, {
      userId: req.userId,
      id: req.params.id,
      localDate: req.body?.localDate,
    });
    return res.status(201).json({ data });
  } catch (err) {
    return fail(res, err, 'habits');
  }
};

export const retryRoutineRewards = async (req, res) => {
  try {
    const data = await payRoutineClaims(prisma, req.userId);
    // Reconcile a crash between saving a drink and creating its coin claim.
    // Original server timestamps preserve spacing on every retry.
    const localDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const logs = await prisma.waterLog.findMany({ where: { userId: req.userId, localDate }, orderBy: { createdAt: 'asc' } });
    const targetMl = await habitsService.waterTargetMl(prisma, req.userId);
    for (const log of logs) {
      const reward = await recordRoutineWater(prisma, { userId: req.userId, localDate, targetMl, now: log.createdAt });
      data.coinsAwarded += reward.coinsAwarded;
      data.pending ||= reward.pending;
    }
    data.coinsAwarded += await retryRoutineWorkouts(prisma, req.userId);
    return res.json({ data });
  }
  catch (err) { return fail(res, err, 'routine-rewards'); }
};
