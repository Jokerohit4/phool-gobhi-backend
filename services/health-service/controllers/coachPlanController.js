import { PrismaClient } from '@prisma/client';
import * as todayService from '../services/plan/todayService.js';
import { rebuildPlan } from '../services/plan/rebuildPlan.js';

const prisma = new PrismaClient();

// Every handler is a thin pass-through to the plan service stubs (UA1). The
// stubs throw {status: 501} until UB4 replaces them; the route contract
// (gates, paths, response shapes) is already final here so the client tasks
// can build against it. Mutations return the fresh today payload so the app
// never needs a second call.

const handle = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.error || err.message || 'Server error',
      code: err.code,
    });
  }
};

export const getToday = handle(async (req, res) => {
  res.json(await todayService.buildToday(prisma, req.userId, { localDate: req.query.localDate }));
});

export const getPlan = handle(async (req, res) => {
  res.json(await todayService.buildPlanDefinition(prisma, req.userId));
});

export const completeItem = handle(async (req, res) => {
  res.json({ today: await todayService.buildToday(prisma, req.userId, { localDate: req.body?.localDate }) });
});

export const uncompleteItem = handle(async (req, res) => {
  res.json({ today: await todayService.buildToday(prisma, req.userId, { localDate: req.query.localDate }) });
});

export const createItem = handle(async (req, res) => {
  const item = await rebuildPlan(prisma, req.userId, { reason: 'edit' });
  res.status(201).json({ item, today: await todayService.buildToday(prisma, req.userId, {}) });
});

export const deleteItem = handle(async (req, res) => {
  res.json({ today: await todayService.buildToday(prisma, req.userId, {}) });
});

export const previewSettings = handle(async (req, res) => {
  res.json({ plan: await todayService.buildPlanDefinition(prisma, req.userId) });
});

export const saveSettings = handle(async (req, res) => {
  await rebuildPlan(prisma, req.userId, { reason: 'edit' });
  res.json({
    plan: await todayService.buildPlanDefinition(prisma, req.userId),
    today: await todayService.buildToday(prisma, req.userId, {}),
  });
});

export const saveSlots = handle(async (req, res) => {
  await rebuildPlan(prisma, req.userId, { reason: 'edit' });
  res.json({
    plan: await todayService.buildPlanDefinition(prisma, req.userId),
    today: await todayService.buildToday(prisma, req.userId, {}),
  });
});

export const foodEarly = handle(async (req, res) => {
  res.json({ today: await todayService.buildToday(prisma, req.userId, {}) });
});
