import * as nutritionService from '../services/ledger/nutritionService.js';
import * as ledgerPlanService from '../services/ledger/ledgerPlanService.js';
import * as scoreService from '../services/ledger/scoreService.js';
import * as dayCloseService from '../services/ledger/dayCloseService.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';
import * as targetService from '../services/ledger/targetService.js';
import { currentNutritionTarget } from '../services/ledger/currentTarget.js';
import * as intakeService from '../services/ledger/ledgerIntakeService.js';
import * as attainmentService from '../services/ledger/attainmentService.js';
import * as scoreTargetService from '../services/ledger/scoreTargetService.js';
import * as medicalDocumentStorage from '../services/ledger/medicalDocumentStorage.js';
import * as foodPhotoService from '../services/ledger/foodPhotoService.js';
import * as foodRequestService from '../services/ledger/foodRequestService.js';
import * as foodAdminService from '../services/ledger/foodAdminService.js';
import * as foodEmbeddingService from '../services/ledger/foodEmbeddingService.js';
import { PrismaClient } from '@prisma/client';
import { track } from '../utils/analytics.js';
import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';
import { evaluateWeeklyRewards, evaluateUserReward } from '../services/rewardService.js';
import { injectAiPrescription } from '../services/aiPrescriptionService.js';
import { correlateMarkerImprovement } from '../services/correlationService.js';
import * as prescriptionService from '../services/ledger/prescriptionService.js';

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
      return res.status(status).json({
        error: err.error || err.message || 'Server error',
        code: err.code,
        // `foods` is the one extra key a service may attach to an error, and it
        // exists for exactly one case: a 409 from the missing-food request saying
        // "we already have that". The rows come back in the error body so the
        // client can show the food the user was one tap from, instead of an
        // error toast on the screen of somebody trying to log dinner. No other
        // error carries data, and this is not a general escape hatch - a service
        // would have to attach it deliberately.
        ...(err.foods ? { foods: err.foods } : {}),
      });
    }
  };
}

const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// ---- Intake ----------------------------------------------------------------

// The setup wizard's read side. Answers "what do you still need from me?", which
// is what lets the screen ask only for what is missing instead of re-asking for
// a height, weight and age the user has already given.
export const getSetup = handle(async (req) => {
  return intakeService.getSetupState({
    prisma,
    userId: req.userId,
    localDate: req.query?.localDate,
    // So age and sex prefill from the signup DOB/gender instead of being asked
    // twice. Prefill only â€” see getSetupState.
    fetchProfile: fetchUserProfileInternal,
  });
});

export const saveSetup = async (req, res) => {
  try {
    const out = await intakeService.saveIntake({
      prisma,
      userId: req.userId,
      input: req.body || {},
      localDate: req.body?.localDate || req.query?.localDate,
    });

    // A 422 with per-field messages, so the form can mark the offending inputs
    // rather than showing one generic failure and losing what was typed. A 200
    // here would let a client treat a rejected save as a success.
    if (out.skipped === 'invalid') {
      return res.status(422).json({
        error: 'Please check the highlighted answers.',
        code: 'INTAKE_INVALID',
        errors: out.errors,
      });
    }

    // Also a refusal, and also not a 200. The request was well-formed and
    // individually valid â€” the target and the date just cannot both be honoured
    // â€” so the screen needs its own copy and the `earliestDate` to offer, which
    // the generic validation branch would throw away.
    if (out.skipped === 'target_too_aggressive') {
      // Recorded before the early return, because health_intake_saved never fires
      // for a refused submission. Without this, a user our own safety cap turns
      // away is indistinguishable from one who abandoned the wizard â€” the two
      // need opposite responses. limitedBy says which bound actually applied, so
      // a cap that is too tight for most users is visible rather than inferred.
      track('health_targets_pace_rejected', req.userId, {
        code: out.pace?.code || null,
        limited_by: out.pace?.limitedBy || null,
        weeks_needed: out.pace?.weeksNeeded ?? null,
        max_weekly_loss_kg: out.pace?.maxWeeklyLossKg ?? null,
      });
      return res.status(422).json({
        error: out.pace.error,
        code: out.pace.code,
        pace: out.pace,
      });
    }

    // Shape only: which fields were answered, whether a weight became a
    // reading. Never the values themselves â€” a body weight has no business in
    // analytics.
    track('health_intake_saved', req.userId, {
      skipped: out.skipped || null,
      hasGoal: out.written === true,
      weightWritten: out.weightWritten === true,
    });
    return res.json({ data: out });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[ledger-intake]', err);
    return res
      .status(status)
      .json({ error: err.error || err.message || 'Server error', code: err.code });
  }
};

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

// A pure read of "where did these numbers come from", and the reason the app
// does not POST to /targets/recompute to get it: doing that made opening the
// targets screen create a NutritionTarget row on every visit, and it could never
// work for a user whose target is `user_edited`, because the recompute is
// refused precisely in that case - leaving the one user who set their own
// numbers with no explanation of them.
//
// Returns the detail even when no target exists at all. The activity half is
// still true and worth showing, and a 404 here would force the client to guess.
export const getTargetActivityDetail = handle(async (req) => {
  return targetService.describeActivity({
    prisma,
    userId: req.userId,
    localDate: req.query?.localDate,
  });
});

export const getTargets = handle(async (req) => {
  const target = await currentNutritionTarget(prisma, req.userId);
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

// ---- The adjustable plan ---------------------------------------------------

export const getPrescription = handle(async (req) => {
  return prescriptionService.getPlan({ prisma, userId: req.userId });
});

// Read-only, and the reason there are two of them: a slider drag asks what the
// rest of the plan becomes, and asking must cost nothing. Nothing in
// previewPlan writes - see the test that pins it.
export const previewPrescription = handle(async (req) => {
  return prescriptionService.previewPlan({
    prisma,
    userId: req.userId,
    draft: req.body || {},
  });
});

export const savePrescription = handle(async (req) => {
  const plan = await prescriptionService.savePlan({
    prisma,
    userId: req.userId,
    draft: req.body || {},
  });
  // Shape only. Never the numbers: a calorie target and a sleep window are
  // health data, and the analytics util's no-PII rule means this dictionary is
  // read by everyone who can query the analytics database. Whether the server
  // had to move anything is the funnel fact - a rate that climbs says our
  // bounds and people's expectations have drifted apart.
  track('health_prescription_saved', req.userId, {
    adjusted: plan.adjustedBy.length > 0,
    had_workout: plan.workout.length > 0,
  });
  return plan;
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
// One food, on the wire. Shared by search and the recent list so the two
// cannot drift into subtly different shapes: the picker renders both through
// the same model, and a field present on one and missing on the other shows as
// a blank on whichever list happened to lose it.
function serializeFood(f) {
  return {
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
  };
}

export const searchFoods = handle(async (req) => {
  const includeUnverified = req.query.includeUnverified !== 'false';
  const rows = await nutritionService.searchFoods(prisma, req.userId, {
    query: req.query.q,
    includeUnverified,
  });
  return rows.map(serializeFood);
});

// A food of the user's own, from the picker's empty state. Returned in the
// search shape so the client can log it straight away and find it again later.
export const createCustomFood = handle(async (req) => {
  const b = req.body || {};
  const food = await nutritionService.createCustomFood(prisma, {
    userId: req.userId,
    name: b.name,
    kcal: b.kcal,
    proteinG: b.proteinG,
    carbsG: b.carbsG,
    fatG: b.fatG,
    servingGrams: b.servingGrams,
    servingLabel: b.servingLabel,
    nonVeg: b.nonVeg === true,
  });
  track('health_custom_food_created', req.userId, {});
  return serializeFood(food);
});

// The picker's opening list. Same shape as search plus the two fields only the
// recent list has: the grams and label the food was last logged with, so the
// amount sheet opens on the portion the user actually chose last time.
export const recentFoods = handle(async (req) => {
  const rows = await nutritionService.recentFoods(prisma, req.userId, {
    limit: num(req.query.limit) || 8,
  });
  return rows.map(({ food, grams, servingLabel }) => ({
    ...serializeFood(food),
    lastGrams: grams == null ? null : Number(grams),
    lastServingLabel: servingLabel || null,
  }));
});

// ---- Missing-food requests -------------------------------------------------
//
// The picker's empty state. The user searched, got nothing, and this is what
// they reach next.
//
// The response shape carries one thing the client needs and cannot derive: if
// the request already existed, `created: false`. A user who asks for omelette
// twice should not be told twice that we have noted it â€” the second time, the
// useful message is that it is already on the list and how many people have
// asked. Whether to say so is the client's call; it needs the fact to decide.

export const requestFood = handle(async (req) => {
  const b = req.body || {};
  const { request, created } = await foodRequestService.requestFood(prisma, {
    userId: req.userId,
    name: b.name,
    query: b.query,
    detail: b.detail,
  });
  // Only the creation is tracked. A repeat ask is the same event as the first
  // one for reporting purposes, and counting both would make this look like
  // growing demand when it is one person being persistent.
  //
  // `name` is the one food-derived property anywhere in this dictionary, and it
  // is deliberate: "which foods are people failing to find" is the entire
  // reason this endpoint exists, and an event with no name in it cannot answer
  // that question at all. So this one carries the food name, and everything
  // else here carries shape only â€” compare health_food_photo_recognized below,
  // which stays nameless because a photo has no name to begin with and its
  // contents are nobody else's business. The difference is not carelessness: a
  // requested food is a thing the user wants the catalogue to have, which is
  // also a thing every other user of the catalogue should get, while the
  // contents of somebody's plate is only ever theirs.
  if (created) track('health_food_requested', req.userId, { name: request.name });
  return {
    id: request.id,
    name: request.name,
    status: request.status,
    requestCount: request.requestCount,
    createdAt: request.createdAt,
    created,
  };
});

export const listFoodRequests = handle(async (req) => {
  const rows = await foodRequestService.listRequests(prisma, {
    userId: req.userId,
    status: req.query.status,
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    // The user's own detail and the reviewer's note are both returned to them:
    // this is their own request, and "we declined this, because it is a dish not
    // an ingredient" is the answer they are entitled to.
    detail: r.detail,
    reviewNote: r.reviewNote,
    requestCount: r.requestCount,
    resolvedAt: r.resolvedAt,
    createdAt: r.createdAt,
  }));
});

// ---- Admin: the request queue ---------------------------------------------
//
// Deliberately narrower than the rest of the admin surface. This route reads
// free-text names a user typed and can resolve a request; it must not be able
// to read anything else about them, so there is no userId in the response and
// no way to ask "what did user 7 request".

export const listFoodRequestQueue = handle(async (req) => {
  const rows = await foodRequestService.listQueue(prisma, {
    status: req.query.status,
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    query: r.query,
    detail: r.detail,
    status: r.status,
    // Demand, not identity: how many times this dish has been asked for.
    requestCount: r.requestCount,
    reviewNote: r.reviewNote,
    resolvedAt: r.resolvedAt,
    createdAt: r.createdAt,
  }));
});

export const resolveFoodRequest = handle(async (req) => {
  const b = req.body || {};
  const updated = await foodRequestService.resolveRequest(prisma, {
    id: req.params.id,
    status: b.status,
    reviewNote: b.reviewNote,
  });
  return { id: updated.id, name: updated.name, status: updated.status };
});

// ----------------------------------------------------------------------
// Admin better-living: food catalogue ops (gobhi role, see routes/health.js).
// The gap between "user free text in the queue" and "reference data" is closed
// exactly once, here, by someone who can source the numbers.
// ----------------------------------------------------------------------

export const createFoodItem = handle(async (req) => {
  const b = req.body || {};
  const out = await foodAdminService.createFood(prisma, {
    name: b.name,
    aliases: b.aliases,
    basis: b.basis,
    kcal: b.kcal,
    proteinG: b.proteinG,
    carbsG: b.carbsG,
    fatG: b.fatG,
    fibreG: b.fibreG,
    ironMg: b.ironMg,
    magnesiumMg: b.magnesiumMg,
    calciumMg: b.calciumMg,
    zincMg: b.zincMg,
    servings: b.servings,
    nonVeg: b.nonVeg,
    veg: b.veg,
    source: b.source,
    verified: b.verified,
    reviewNote: b.reviewNote,
  });
  track('health_food_added', req.userId, {
    source: out.food.source,
    verified: out.food.verified,
    resolved_requests: out.resolvedRequests,
  });
  return out;
});

// ----------------------------------------------------------------------
// On-device matcher: the text half (see foodEmbeddingService.js).
// ----------------------------------------------------------------------

export const getFoodEmbeddings = handle(async () => {
  return foodEmbeddingService.getForMatcher(prisma);
});

export const refreshFoodEmbeddings = handle(async (req) => {
  const out = await foodEmbeddingService.refreshAll(prisma);
  track('health_food_embeddings_refreshed', req.userId, {
    computed: out.computed,
    model: out.model,
  });
  return out;
});

export const logFood = handle(async (req) => {
  const b = req.body || {};
  // Two ways in, one route. A catalogue log carries `foodItemId`; a hand-typed
  // one carries `name` + `kcal` instead. Branching here rather than adding a
  // second route keeps the client's one "log a food" call one call, and the
  // service refuses a body that has neither (or both) by what it validates.
  if (b.foodItemId == null && (b.name != null || b.kcal != null)) {
    const out = await nutritionService.logQuickFood(prisma, {
      userId: req.userId,
      localDate: b.localDate,
      slot: b.slot,
      name: b.name,
      kcal: isNum(b.kcal) ? Number(b.kcal) : b.kcal,
      grams: isNum(b.grams) ? Number(b.grams) : 100,
      servingLabel: b.servingLabel,
    });
    track('health_food_logged', req.userId, { slot: b.slot, source: 'custom' });
    return out;
  }

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

// Repeat a whole day's log onto another date. Reaches the same foods-logged
// funnel as a search or a saved meal, tagged `repeat_day`, so the feature's
// usage is a source split on one event rather than a separate event that has to
// be summed by hand. The slot is passed through as null when the caller did not
// force one - the service then keeps each row in its original meal, and the
// event mirrors that rather than inventing a slot the rows did not get.
export const repeatFoodLogs = handle(async (req) => {
  const b = req.body || {};
  const out = await nutritionService.repeatDay(prisma, {
    userId: req.userId,
    fromLocalDate: b.fromLocalDate,
    localDate: b.localDate,
    slot: b.slot,
  });
  track('health_food_logged', req.userId, {
    slot: b.slot || null,
    source: 'repeat_day',
    logged_count: out?.logged ?? null,
    skipped_count: Array.isArray(out?.skipped) ? out.skipped.length : null,
  });
  return out;
});

export const getDayTotals = handle(async (req) => {
  const { localDate } = req.params;
  const day = await nutritionService.getDayTotals(prisma, req.userId, localDate);
  const target = await currentNutritionTarget(prisma, req.userId);
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

export const deleteFoodLog = handle(async (req) => {
  // The photo is read before the delete, because after it the row is gone and
  // there is nothing left to ask about the object behind it.
  const before = await prisma.foodLog.findFirst({
    where: { id: Number(req.params.id), userId: req.userId },
    select: { id: true, photoPath: true },
  });
  const deleted = await nutritionService.deleteLog(prisma, req.userId, req.params.id);

  // Only the LAST line from a photo releases the object - one photo produces
  // several logs, and deleting on the first would break the photo still shown
  // on the others. Best-effort, same as the medical document path above.
  if (before?.photoPath) {
    await foodPhotoService
      .releasePhotoIfUnreferenced(prisma, { photoPath: before.photoPath })
      .catch((err) => console.error('[ledger] photo release failed:', err.message));
  }

  return deleted;
});

// A correction, not an overwrite: the service decides which parts of the row
// may move and recomputes the snapshot when the portion does. Every body field
// is optional and an absent one means "leave it alone", which is why a missing
// number arrives as null rather than as undefined-or-zero.
export const updateFoodLog = handle(async (req) => {
  const b = req.body || {};
  return nutritionService.updateLog(prisma, req.userId, req.params.id, {
    grams: isNum(b.grams) ? Number(b.grams) : null,
    servings: isNum(b.servings) ? Number(b.servings) : null,
    servingLabel: b.servingLabel,
    slot: b.slot,
  });
});

export const saveMeal = handle(async (req) => {
  const b = req.body || {};
  const out = await nutritionService.saveMeal(prisma, { userId: req.userId, ...b });
  // Snapshotting a day as reusable is a distinct decision from logging a food,
  // and it is the one that predicts repeat use. Without this event the saved-meal
  // feature was entirely invisible, so "saved a meal" and "re-logged one" could
  // not be separated from users who simply never opened the sheet.
  track('health_saved_meal_created', req.userId, {
    slot: b.slot || null,
    line_count: Array.isArray(out?.lines) ? out.lines.length : null,
  });
  return out;
});

export const listSavedMeals = handle(async (req) =>
  nutritionService.listSavedMeals(prisma, req.userId),
);

export const logSavedMeal = handle(async (req) => {
  const b = req.body || {};
  const out = await nutritionService.logSavedMeal(prisma, {
    userId: req.userId,
    savedMealId: req.params.id,
    localDate: b.localDate,
    slot: b.slot,
  });
  // Same event as the search path, tagged by origin, so foods logged is one
  // funnel with a source split rather than two events that have to be summed
  // correctly by hand. The counts matter because a repeat is many foods in one
  // request: counting it as one food would understate the feature, and
  // skipped_count > 0 means foods left the catalogue after the meal was saved,
  // which the client surfaces as a partial-write warning.
  track('health_food_logged', req.userId, {
    slot: b.slot || null,
    source: 'saved_meal',
    logged_count: out?.logged ?? null,
    skipped_count: Array.isArray(out?.skipped) ? out.skipped.length : null,
  });
  return out;
});

export const updateSavedMeal = handle(async (req) => {
  const b = req.body || {};
  return nutritionService.updateSavedMeal(prisma, {
    userId: req.userId,
    id: req.params.id,
    name: b.name,
    slot: b.slot,
  });
});

export const deleteSavedMeal = handle(async (req) => {
  await nutritionService.deleteSavedMeal(prisma, {
    userId: req.userId,
    id: req.params.id,
  });
  return { deleted: true };
});

// ---- Plan ----------------------------------------------------------------

// Regenerating suggestions is the only write here that is not the user's own
// words, and it only ever writes origin 'suggested' - see ledgerPlanService.js.
export const regeneratePlan = handle(async (req) => {
  const goal = await prisma.healthGoal.findUnique({ where: { userId: req.userId } });
  const target = await currentNutritionTarget(prisma, req.userId);
  if (!target) {
    const err = new Error('Set a nutrition target before generating a plan');
    err.status = 400;
    throw err;
  }
  const out = await ledgerPlanService.regenerateSuggestions(prisma, {
    userId: req.userId,
    // The whole set. The generator is currently goal-agnostic (it keys items off
    // the nutrient targets rather than the objective), so this is not yet load-
    // bearing â€” but passing one of several goals here would bake in a choice this
    // endpoint has no basis to make.
    goals: goal?.goals ?? [],
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

// Pause: the score's off-ramp. Today comes from the query for the same reason
// every other ledger route takes it that way - the user's day is their own, and
// the server's calendar is not theirs.
//
// `today` is validated here, which the other ledger routes do not do, and the
// reason is specific rather than general. Everywhere else a malformed localDate
// produces a harmless odd result. Here it is written to the goal: a pause
// starting on "2026-13-45" would never match a real day, so the user would press
// pause, be told it worked, and find their score still falling. That is a lie
// from the API, so it is refused at the boundary. The service checks again,
// because it is the thing that actually writes the column and it is also called
// directly by tests.
//
// The validator is the service's, imported rather than reimplemented: a regex
// here and a stricter check there is exactly how a boundary ends up accepting
// what the thing it guards rejects.
function requireToday(value) {
  if (!scoreService.isIsoDay(value)) {
    const err = new Error('today must be YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  return String(value);
}

export const getPause = handle(async (req) =>
  scoreService.getPauseState(prisma, { userId: req.userId, today: requireToday(req.query?.today) }),
);

export const setPause = handle(async (req) =>
  scoreService.setPause(prisma, {
    userId: req.userId,
    days: num(req.body?.days),
    today: requireToday(req.body?.today || req.query?.today),
  }),
);

export const clearPause = handle(async (req) =>
    scoreService.clearPause(prisma, { userId: req.userId }),
  );

  // Attainment reads the weight series up to a day boundary, so `today` is
  // required and validated the same way pause requires it. A missing or malformed
  // date here would not be a cosmetic oddity: it decides which readings are
  // visible at all, so a bad one would let a future-dated weigh-in into the
  // series and could report the goal as met.
  export const getAttainment = handle(async (req) =>
    attainmentService.getAttainment(prisma, {
      userId: req.userId,
      localDate: requireToday(req.query?.today),
    }),
  );

// ---- Score target --------------------------------------------------------
//
// The number the user is aiming at, and the window they gave themselves. `today`
// is required and validated on all three, for the same reason pause requires it:
// every one of them reads a day boundary to decide what "elapsed" and "left"
// mean, and it is written to the goal on set. A malformed date here does not
// produce a cosmetic oddity, it produces a target whose progress is computed
// against a day that does not exist.
//
// `num` is used for both fields rather than being passed raw, so a non-numeric
// body reaches the service as null and the service's own bounds check produces
// the 400 with a message that says what the range is. A regex here would accept a
// shape and reject it in a different shape in the service.
export const getScoreTarget = handle(async (req) =>
  scoreTargetService.getScoreTargetState(prisma, {
    userId: req.userId,
    today: requireToday(req.query?.today),
  }),
);

export const getBlendedScore = handle(async (req) =>
  scoreService.getBlendedScore(prisma, { userId: req.userId }),
);

export const setScoreTarget = handle(async (req) =>
  scoreTargetService.setScoreTarget(prisma, {
    userId: req.userId,
    points: num(req.body?.points),
    days: num(req.body?.days),
    today: requireToday(req.body?.today || req.query?.today),
  }),
);

export const clearScoreTarget = handle(async (req) =>
  scoreTargetService.clearScoreTarget(prisma, { userId: req.userId }),
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

// The server decides what "today" is. `?today=` from older app builds is
// accepted and ignored rather than rejected, so those builds keep working - but
// it no longer reaches the engine, and a future day is refused outright. See
// dayCloseService.js for why the client's clock stopped being trusted here.
export const closeScoreDay = handle(async (req) => {
  const { today } = dayCloseService.resolveClientClose({ localDate: req.params.localDate });
  const out = await scoreService.closeDay(prisma, {
    userId: req.userId,
    localDate: req.params.localDate,
    today,
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

// ---- Photo food logging ----------------------------------------------------

// Internal: the platform-wide sweep.
export const evaluateRewards = handle(async (req) => {
  return await evaluateWeeklyRewards();
});

// User-facing: the caller's own bonus only. This route used to run the
// platform-wide sweep above, so any signed-in user could trigger a pass over
// every user's scores.
export const evaluateMyReward = handle(async (req) => {
  return await evaluateUserReward(req.userId);
});

export const prescribeAiPlan = handle(async (req) => {
  return await injectAiPrescription(req.userId, req.body);
});

export const getBiomarkerTrajectory = handle(async (req) => {
  return await scoreService.getBiomarkerTrajectory(prisma, { 
    userId: req.userId, 
    marker: req.query.marker, 
    days: req.query.days 
  });
});

export const getMarkerCorrelation = handle(async (req) => {
  return await correlateMarkerImprovement(req.userId, req.query.marker);
});

export const getBatchConsistency = handle(async (req) => {
  return await scoreService.getBatchBehavioralConsistency(prisma, { 
    userIds: req.body.userIds 
  });
});

// The one surface in this service that sends an image to a third party, and the
// one that stores an image the user chose to keep. Everything else about a
// prescription in this file is deliberately undone here: the medical path stores
// bytes and never reads them, and this one sends them to a model on purpose. The
// two live in separate modules and separate buckets for exactly that reason -
// see foodPhotoStorage.js and the invariants in medicalDocumentStorage.js.
//
// Two calls, and the split is the feature. Recognize proposes, confirm writes.
export const recognizeFoodPhoto = handle(async (req) => {
  if (!req.file) {
    throw Object.assign(new Error('No photo received'), { status: 400, code: 'NO_PHOTO' });
  }

  const out = await foodPhotoService.recognizePhoto(prisma, {
    userId: req.userId,
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    // Which candidate in the provider rotation serves this request. Multipart
    // delivers it as a string (coerced in providers/index.js); app versions
    // that predate the rotation send nothing and get attempt 1 â€” the vendor
    // they always had.
    attempt: req.body?.attempt,
  });

  // Shape only. Never the proposed food names, never a count of what was on the
  // plate: a photo of a plate is a description of someone's diet, and this
  // dictionary is read by everyone who can query the analytics database.
  track('health_food_photo_recognized', req.userId, {
    is_food: out.isFood === true,
    matched_count: out.items.length,
    unmatched_count: out.unmatched.length,
  });

  return out;
});

// The on-device matcher's storage half: claim a photo that never reaches the
// vision model. No health_food_photo_recognized here on purpose - nothing was
// recognised, the phone did the naming, and firing that funnel port would make
// on-device matches look like model recognition. The event that decides whether
// the short-circuit earns its keep is the client's own `food_photo_on_device`.
export const uploadFoodPhoto = handle(async (req) => {
  if (!req.file) {
    throw Object.assign(new Error('No photo received'), { status: 400, code: 'NO_PHOTO' });
  }

  return foodPhotoService.uploadPhotoOnly(prisma, {
    userId: req.userId,
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
  });
});

export const confirmFoodPhoto = handle(async (req) => {
  const b = req.body || {};
  const out = await foodPhotoService.confirmPhotoLog(prisma, {
    userId: req.userId,
    photoPath: b.photoPath,
    localDate: b.localDate,
    slot: b.slot,
    lines: Array.isArray(b.lines) ? b.lines : [],
  });

  // Reached the same foods-logged funnel as search and saved-meal repeat, with
  // the origin split already on that event's `source`. Splitting photo into its
  // own event would have made "how many foods does this app log" a sum across
  // three queries instead of one.
  track('health_food_logged', req.userId, {
    slot: b.slot,
    source: 'photo_confirmed',
    logged_count: out.logged,
    pending_count: out.pending,
  });
  // The launch metric, as a funnel rather than a dashboard-only number: if
  // corrections stay high, this is the event that says the feature is not
  // earning its per-photo cost.
  track('health_food_photo_confirmed', req.userId, {
    slot: b.slot,
    logged_count: out.logged,
    pending_count: out.pending,
    corrections: out.corrections,
    rejected_count: out.rejected.length,
  });

  return out;
});

export const getFoodPhotoLink = handle(async (req) => {
  const { url } = await foodPhotoService.getPhotoLink(prisma, {
    userId: req.userId,
    logId: req.params.id,
  });
  return { url, expiresInSeconds: 300 };
});

// Reclaims photos that were uploaded and never confirmed. Exposed on the health
// admin surface rather than run by a scheduler, because this fleet has no cron
// and an unset interval in Cloud Run is a job that silently never runs. The
// endpoint is deliberately not part of the customer app's routes.
export const sweepFoodPhotos = handle(async () =>
  foodPhotoService.sweepUnconfirmedPhotos(prisma, { olderThanHours: 24 }),
);

// Nightly: freeze yesterday for every ledger user who has not. Internal only,
// fired by .github/workflows/close-ledger-days.yml. Returns counts so the run
// log shows what happened, including how many were skipped and why that is not
// an error.
export const runDayCloseSweepInternal = handle(async () =>
  dayCloseService.runDayCloseSweep(prisma, { isEnabled: isFeatureEnabled }),
);
