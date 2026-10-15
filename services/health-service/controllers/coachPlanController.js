import { PrismaClient } from '@prisma/client';
import * as todayService from '../services/plan/todayService.js';
import { rebuildPlan } from '../services/plan/rebuildPlan.js';
import * as prescriptionService from '../services/ledger/prescriptionService.js';
import * as ledgerPlanService from '../services/ledger/ledgerPlanService.js';
import { unlockFoodEarly } from '../journey/journeyService.js';
import { track } from '../utils/analytics.js';

const prisma = new PrismaClient();

function handle(fn) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[coachPlan]', err);
      return res.status(status).json({
        error: err.error || err.message || 'Server error',
        code: err.code,
        ...(err.layer ? { layer: err.layer } : {}),
        ...(err.field ? { field: err.field } : {}),
      });
    }
  };
}

// GET /plan/today
export const getToday = handle(async (req, res) => {
  const localDate = req.query.localDate;
  const today = await todayService.buildToday(prisma, req.userId, { localDate });
  res.json(today);
});

// GET /plan
export const getPlan = handle(async (req, res) => {
  const plan = await todayService.buildPlanDefinition(prisma, req.userId);
  res.json(plan);
});

// POST /plan/items/:id/complete
export const completeItem = handle(async (req, res) => {
  const { id } = req.params;
  const { localDate } = req.body || {};

  // Validate date if provided
  if (localDate && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    const err = new Error('localDate must be YYYY-MM-DD');
    err.status = 400;
    err.code = 'VALIDATION';
    err.field = 'localDate';
    throw err;
  }
  if (localDate && todayService.isFutureDate(localDate)) {
    const err = new Error('Cannot complete for a future date');
    err.status = 400;
    err.code = 'VALIDATION';
    err.field = 'localDate';
    throw err;
  }

  const item = await prisma.planItem.findFirst({ where: { id: Number(id), userId: req.userId } });
  if (!item) {
    const err = new Error('Plan item not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!item.active) {
    const err = new Error('That item is not active');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }

  // Check layer is on
  const onLayerKeys = await todayService.getOnLayerKeys(prisma, req.userId);
  if (item.layerKey && !onLayerKeys.includes(item.layerKey)) {
    const err = new Error('This plan layer is not active');
    err.status = 409;
    err.code = 'LAYER_NOT_ON';
    err.layer = item.layerKey;
    throw err;
  }

  const completed = await ledgerPlanService.completeItem(prisma, {
    userId: req.userId,
    planItemId: Number(id),
    localDate: localDate || todayService.todayIST(),
    how: 'manual',
  });

  // Emit analytics
  track('plan_item_completed', req.userId, {
    row_kind: item.kind,
    layer: item.layerKey,
  });

  const today = await todayService.buildToday(prisma, req.userId, { localDate });
  res.json({ today });
});

// DELETE /plan/items/:id/complete
export const uncompleteItem = handle(async (req, res) => {
  const { id } = req.params;
  const { localDate } = req.query;

  if (localDate && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    const err = new Error('localDate must be YYYY-MM-DD');
    err.status = 400;
    err.code = 'VALIDATION';
    err.field = 'localDate';
    throw err;
  }

  const item = await prisma.planItem.findFirst({ where: { id: Number(id), userId: req.userId } });
  if (!item) {
    const err = new Error('Plan item not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  try {
    await ledgerPlanService.uncompleteItem(prisma, {
      userId: req.userId,
      planItemId: Number(id),
      localDate: localDate || todayService.todayIST(),
    });
  } catch (err) {
    if (err.status === 409 && err.code === 'AUTO_DONE') {
      throw err;
    }
    throw err;
  }

  const today = await todayService.buildToday(prisma, req.userId, { localDate });
  res.json({ today });
});

// POST /plan/items
export const createItem = handle(async (req, res) => {
  const { type, ...data } = req.body || {};

  if (type === 'own') {
    const { title, ownKind, schedule } = data;
    if (!title || !ownKind || !schedule) {
      const err = new Error('title, ownKind, and schedule are required');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (!['habit', 'workout'].includes(ownKind)) {
      const err = new Error('ownKind must be habit or workout');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (title.length > 60) {
      const err = new Error('Title must be 60 characters or less');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    const activeCount = await prisma.planItem.count({ where: { userId: req.userId, active: true } });
    if (activeCount >= 20) {
      const err = new Error('Your plan already has 20 active items. Remove one to add another.');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    const item = await prisma.planItem.create({
      data: {
        userId: req.userId,
        kind: ownKind,
        title: title.trim(),
        schedule: schedule.trim(),
        origin: 'user',
        ownKind,
        active: true,
        autoGenerated: false,
      },
    });

    track('plan_edited', req.userId, { what: 'item_added' });

    const today = await todayService.buildToday(prisma, req.userId, {});
    res.status(201).json({ item, today });
  } else if (type === 'doctor') {
    const { kind, title, schedule, prescribedBy, prescribedNote, endsOn } = data;
    if (!kind || !title || !schedule) {
      const err = new Error('kind, title, and schedule are required');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }
    if (!['doctor_medication', 'doctor_test', 'doctor_appointment'].includes(kind)) {
      const err = new Error('kind must be doctor_medication, doctor_test, or doctor_appointment');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    // Check medical_records consent
    const consent = await prisma.healthConsent.findUnique({ where: { userId: req.userId } });
    if (!consent || consent.revokedAt || !consent.scopes?.includes('medical_records')) {
      const err = new Error('Medical records consent required');
      err.status = 403;
      err.code = 'CONSENT_REQUIRED';
      err.scope = 'medical_records';
      throw err;
    }

    const activeCount = await prisma.planItem.count({ where: { userId: req.userId, active: true } });
    if (activeCount >= 20) {
      const err = new Error('Your plan already has 20 active items. Remove one to add another.');
      err.status = 400;
      err.code = 'VALIDATION';
      throw err;
    }

    const item = await prisma.planItem.create({
      data: {
        userId: req.userId,
        kind,
        title: title.trim(),
        schedule: schedule.trim(),
        origin: 'doctor',
        prescribedBy: prescribedBy?.trim() || null,
        prescribedNote: prescribedNote?.trim() || null,
        endsOn: endsOn || null,
        active: true,
        autoGenerated: false,
        layerKey: kind === 'doctor_appointment' ? 'health' : 'medicine',
      },
    });

    track('plan_edited', req.userId, { what: 'item_added' });

    const today = await todayService.buildToday(prisma, req.userId, {});
    res.status(201).json({ item, today });
  } else {
    const err = new Error('type must be "own" or "doctor"');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
});

// DELETE /plan/items/:id
export const deleteItem = handle(async (req, res) => {
  const { id } = req.params;

  const item = await prisma.planItem.findFirst({ where: { id: Number(id), userId: req.userId } });
  if (!item) {
    const err = new Error('Plan item not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (item.origin === 'suggested') {
    const err = new Error('Suggested items cannot be deleted directly. Change them through settings or slots.');
    err.status = 409;
    err.code = 'SUGGESTED_ROW';
    throw err;
  }

  await prisma.planItem.update({ where: { id: item.id }, data: { active: false } });

  track('plan_edited', req.userId, { what: 'item_removed' });

  const today = await todayService.buildToday(prisma, req.userId, {});
  res.json({ today });
});

// POST /plan/settings/preview
export const previewSettings = handle(async (req, res) => {
  const draft = req.body || {};
  const journey = await todayService.getJourney(req.userId); // We need to expose getJourney
  const plan = await prescriptionService.previewPlan({ prisma, userId: req.userId, draft, journey });
  res.json({ plan });
});

// PUT /plan/settings
export const saveSettings = handle(async (req, res) => {
  const draft = req.body || {};
  const journey = await todayService.getJourney(req.userId);
  const { plan, today } = await prescriptionService.saveSettings({ prisma, userId: req.userId, draft, journey });
  track('plan_edited', req.userId, { what: 'settings' });
  res.json({ plan, today });
});

// PUT /plan/slots
export const saveSlots = handle(async (req, res) => {
  const { slots } = req.body || {};
  if (!Array.isArray(slots)) {
    const err = new Error('slots must be an array');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
  const journey = await todayService.getJourney(req.userId);
  const { plan, today } = await prescriptionService.saveSlots({ prisma, userId: req.userId, slots, journey });
  track('plan_edited', req.userId, { what: 'slots' });
  res.json({ plan, today });
});

// POST /plan/layers/food/early
export const foodEarly = handle(async (req, res) => {
  await unlockFoodEarly(req.userId);

  const today = await todayService.buildToday(prisma, req.userId, {});
  res.json({ today });
});