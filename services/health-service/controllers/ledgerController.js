import * as nutritionService from '../services/ledger/nutritionService.js';
import * as ledgerPlanService from '../services/ledger/ledgerPlanService.js';
import * as scoreService from '../services/ledger/scoreService.js';
import * as targetService from '../services/ledger/targetService.js';
import * as medicalDocumentStorage from '../services/ledger/medicalDocumentStorage.js';
import { PrismaClient } from '@prisma/client';
import { track } from '../utils/analytics.js';

const prisma = new PrismaClient();

// Every handler here is a thin adapter: parse, delegate, wrap errors. The rules
// live in the services, because a rule enforced in a controller is a rule that
// the next controller forgets.

// Analytics on the funnel events only. Deliberately no properties derived from
// a food, a weight, or a score - the analytics util documents the no-PII rule,
// and a body weight is the most identifying health number there is. The events
// carry shape, not content: "a day was closed", not "650 kcal on Tuesday".
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function handle(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req);
      return res.json({ data });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[ledger]', err);
      return res
        .status(status)
        .json({ error: err.error || err.message || 'Server error', code: err.code });
    }
  };
}

const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// ---- Targets --------------------------------------------------------------

// Recomputes from the weight/height/activity actually on file, so a user who
// has logged 78 kg gets targets for 78 kg rather than for whatever they typed
// at intake.
export const recomputeTargets = handle(async (req) => {
  const out = await targetService.recomputeTargets({
    prisma,
    userId: req.userId,
    localDate: req.body?.localDate || req.query?.localDate,
  });
  // `written: false, skipped: 'user_edited'` is the common, correct outcome -
  // the service refuses to clobber a target the user set by hand, so tracking
  // "recomputed" unconditionally would overstate how often the formula runs.
  track('health_target_recomputed', req.userId, {
    written: out?.written === true,
    skipped: out?.skipped || null,
  });
  return out;
});

export const getTargets = handle(async (req) => {
  const target = await prisma.nutritionTarget.findUnique({ where: { userId: req.userId } });
  if (!target) return null;
  // Decimal columns come back as strings over JSON, which would make the
  // client parse every number. Normalised once, here.
  return {
    ...target,
    kcal: Number(target.kcal),
    proteinG: Number(target.proteinG),
    carbsG: Number(target.carbsG),
    fatG: Number(target.fatG),
    fibreG: Number(target.fibreG),
    waterMl: Number(target.waterMl),
  };
});

// ---- Food search and logging --------------------------------------------

// includeUnverified defaults TRUE on this route, and that is a deliberate
// departure from the service default.
//
// The seeded catalogue is entirely unverified pending nutritionist sign-off, so
// the service default would return an empty list to every user and the food log
// would be unusable. The alternative - shipping only verified foods - means
// shipping no foods. What makes this acceptable rather than a shortcut: the
// rows are clearly labelled `source: 'estimate'` in the database, the response
// carries that flag through to the client, and the numbers are never presented
// as authoritative. Once a nutritionist signs the catalogue off this can
// default to false, which is the state the code should end up in.
export const searchFoods = handle(async (req) => {
  const includeUnverified = req.query.includeUnverified !== 'false';
  const rows = await nutritionService.searchFoods(prisma, req.userId, {
    query: req.query.q,
    includeUnverified,
  });
  return rows.map((f) => ({
    id: f.id,
    name: f.name,
    aliases: f.aliases,
    basis: f.basis,
    servings: f.servings,
    nonVeg: f.nonVeg,
    // Carried to the client so it can say "approximate, not verified" rather
    // than implying a precision the data does not have.
    verified: f.verified,
    source: f.source,
    kcal: Number(f.kcal),
    proteinG: Number(f.proteinG),
    carbsG: Number(f.carbsG),
    fatG: Number(f.fatG),
    fibreG: Number(f.fibreG),
    ironMg: f.ironMg == null ? null : Number(f.ironMg),
  }));
});

export const logFood = handle(async (req) => {
  const b = req.body || {};
  const out = await nutritionService.logFood(prisma, {
    userId: req.userId,
    localDate: b.localDate,
    slot: b.slot,
    foodItemId: b.foodItemId,
    grams: isNum(b.grams) ? Number(b.grams) : null,
    servings: isNum(b.servings) ? Number(b.servings) : null,
    servingLabel: b.servingLabel,
    source: 'search',
  });
  track('health_food_logged', req.userId, { slot: b.slot, source: 'search' });
  return out;
});

export const getDayTotals = handle(async (req) => {
  const { localDate } = req.params;
  const day = await nutritionService.getDayTotals(prisma, req.userId, localDate);
  const target = await prisma.nutritionTarget.findUnique({ where: { userId: req.userId } });
  const targets = target
    ? {
        kcal: Number(target.kcal),
        proteinG: Number(target.proteinG),
        carbsG: Number(target.carbsG),
        fatG: Number(target.fatG),
        fibreG: Number(target.fibreG),
      }
    : null;
  return {
    ...day,
    // Signed, positive = under target. The sign convention is asserted in the
    // service tests because inverting it would reward overeating.
    delta: targets ? nutritionService.deltaFromTarget(day.totals, targets) : null,
    progress: targets ? nutritionService.progressAgainstTarget(day.totals, targets) : null,
  };
});

export const deleteFoodLog = handle(async (req) =>
  nutritionService.deleteLog(prisma, req.userId, req.params.id),
);

export const saveMeal = handle(async (req) =>
  nutritionService.saveMeal(prisma, { userId: req.userId, ...(req.body || {}) }),
);

export const listSavedMeals = handle(async (req) =>
  nutritionService.listSavedMeals(prisma, req.userId),
);

export const logSavedMeal = handle(async (req) =>
  nutritionService.logSavedMeal(prisma, {
    userId: req.userId,
    savedMealId: req.params.id,
    localDate: req.body?.localDate,
    slot: req.body?.slot,
  }),
);

// ---- Plan ----------------------------------------------------------------

// Regenerating suggestions is the only write here that is not the user's own
// words, and it only ever writes origin 'suggested' - see ledgerPlanService.js.
export const regeneratePlan = handle(async (req) => {
  const goal = await prisma.healthGoal.findUnique({ where: { userId: req.userId } });
  const target = await prisma.nutritionTarget.findUnique({ where: { userId: req.userId } });
  if (!target) {
    const err = new Error('Set a nutrition target before generating a plan');
    err.status = 400;
    throw err;
  }
  const out = await ledgerPlanService.regenerateSuggestions(prisma, {
    userId: req.userId,
    goal: goal?.goal,
    diet: goal?.diet,
    targets: {
      kcal: Number(target.kcal),
      proteinG: Number(target.proteinG),
      carbsG: Number(target.carbsG),
      fatG: Number(target.fatG),
      fibreG: Number(target.fibreG),
      waterMl: Number(target.waterMl),
      micros: target.micros,
    },
    measuredActivity: goal?.activityIsMeasured === true,
  });
  track('health_plan_regenerated', req.userId, { created: out.created, dropped: out.dropped });
  return out;
});

// A doctor item is reachable ONLY through here, and `fromPrescription` is a
// field on the body the user controls. That is the intended shape: the user is
// transcribing their own prescription, and the service records the words. There
// is no medicine picker, no dose, and no validation of the content - see the
// header of ledgerPlanService.js.
export const addPlanItem = handle(async (req) => {
  const b = req.body || {};
  const out = await ledgerPlanService.addUserEnteredItem(prisma, {
    userId: req.userId,
    title: b.title,
    kind: b.kind,
    schedule: b.schedule,
    endsOn: b.endsOn,
    fromPrescription: b.fromPrescription === true,
    prescribedBy: b.prescribedBy,
    prescribedNote: b.prescribedNote,
  });
  return out;
});

export const getPlan = handle(async (req) => {
  const { localDate } = req.params;
  const out = await ledgerPlanService.getPlanForDate(prisma, {
    userId: req.userId,
    localDate,
    today: req.query.today || localDate,
  });
  return out;
});

export const completePlanItem = handle(async (req) =>
  ledgerPlanService.completeItem(prisma, {
    userId: req.userId,
    planItemId: req.params.id,
    localDate: req.body?.localDate,
    // `how` is forced to 'manual' here. A client cannot POST how: 'auto' to
    // make something worth zero, and cannot POST points at all - the service
    // derives both.
    how: 'manual',
  }),
);

export const deactivatePlanItem = handle(async (req) =>
  ledgerPlanService.deactivateItem(prisma, { userId: req.userId, planItemId: req.params.id }),
);

// ---- Score ---------------------------------------------------------------

export const getScoreSeries = handle(async (req) =>
  scoreService.getScoreSeries(prisma, { userId: req.userId, limit: num(req.query.limit) || 90 }),
);

// Calm mode is a display preference, so this returns the flattened series when
// it is on. The stored snapshots are untouched either way.
export const getCalmSeries = handle(async (req) =>
  scoreService.getCalmSeries(prisma, { userId: req.userId, limit: num(req.query.limit) || 90 }),
);

export const getSafetyFlag = handle(async (req) => scoreService.getSafetyFlag(prisma, { userId: req.userId }));

export const setCalmMode = handle(async (req) =>
  scoreService.setCalmMode(prisma, { userId: req.userId, calmMode: req.body?.calmMode === true }),
);

// Previewing today writes nothing, so this is safe to call on every screen
// render. Closing a day is the only thing that freezes one, and it is
// idempotent.
export const previewScore = handle(async (req) =>
  scoreService.previewDay(prisma, {
    userId: req.userId,
    localDate: req.params.localDate,
    today: req.query.today || req.params.localDate,
  }),
);

export const closeScoreDay = handle(async (req) => {
  const out = await scoreService.closeDay(prisma, {
    userId: req.userId,
    localDate: req.params.localDate,
    today: req.query.today || req.params.localDate,
  });
  track('health_day_closed', req.userId, { frozen: out?.alreadyClosed !== true });
  return out;
});

// ---- Medical documents ---------------------------------------------------
//
// The only surface in this service that touches a medical record, and it does
// exactly three things: store the bytes, mint a short-lived link, delete. It
// never reads the content. There is no OCR, no model call, and no parse
// anywhere on this path - see medicalDocumentStorage.js.

const DOC_KINDS = ['prescription', 'lab_report', 'scan', 'other'];

// `req.file` is populated by the multer middleware on the route.
export const uploadMedicalDocument = handle(async (req) => {
  if (!req.file) {
    const err = new Error('No file received');
    err.status = 400;
    throw err;
  }
  const kind = DOC_KINDS.includes(req.body?.kind) ? req.body.kind : 'other';

  if (!medicalDocumentStorage.isAllowedMimeType(req.file.mimetype)) {
    const err = new Error('That file type is not accepted');
    err.status = 400;
    throw err;
  }

  const storagePath = await medicalDocumentStorage.saveDocument({
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    userId: req.userId,
  });

  const doc = await prisma.medicalDocument.create({
    data: {
      userId: req.userId,
      storagePath,
      kind,
      title: String(req.body?.title || '').trim().slice(0, 120) || 'Document',
      docDate: req.body?.docDate || null,
      notes: req.body?.notes ? String(req.body.notes).slice(0, 500) : null,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    },
  });

  // No filename, no title, no docDate in the event. The fact that a document
  // was uploaded is the only thing worth a funnel; what it says is nobody's
  // business.
  track('health_medical_doc_uploaded', req.userId, { kind });

  // storagePath is deliberately excluded from the response: a path is a
  // capability, and there is no reason for it to leave the service when the
  // signed link is minted on demand instead.
  const { storagePath: _omit, ...safe } = doc;
  return safe;
});

export const listMedicalDocuments = handle(async (req) => {
  const docs = await prisma.medicalDocument.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
  });
  return docs.map(({ storagePath, ...safe }) => safe);
});

// Minted per read, 5 minutes, never persisted - so revoking consent has nothing
// to walk: the links already in the wild simply expire.
export const getMedicalDocumentLink = handle(async (req) => {
  const doc = await prisma.medicalDocument.findFirst({
    where: { id: Number(req.params.id), userId: req.userId },
  });
  if (!doc) {
    const err = new Error('No such document');
    err.status = 404;
    throw err;
  }
  return { url: await medicalDocumentStorage.signedDocumentUrl(doc.storagePath), expiresInSeconds: 300 };
});

export const deleteMedicalDocument = handle(async (req) => {
  const doc = await prisma.medicalDocument.findFirst({
    where: { id: Number(req.params.id), userId: req.userId },
  });
  if (!doc) {
    const err = new Error('No such document');
    err.status = 404;
    throw err;
  }
  await prisma.medicalDocument.delete({ where: { id: doc.id } });
  // Best-effort: the row is gone, so the object is unreachable from the app
  // even if this fails. deleteUserObjects is the later backstop.
  await medicalDocumentStorage.deleteObjects([doc.storagePath]).catch((err) =>
    console.error('[ledger] object delete failed:', err.message),
  );
  return { deleted: true };
});
