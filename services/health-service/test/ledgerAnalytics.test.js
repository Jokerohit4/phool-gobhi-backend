import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// The health-ledger funnel had ten events already written into the controllers
// and none of them registered in docs/analytics-events.json, so the deploy
// check was failing and the analytics table had no rows for the feature at all.
// Worse, the saved-meal feature had no event *anywhere* - saveMeal and
// logSavedMeal had no track() call - so a user snapshotting "my usual breakfast"
// and a user who never opened the sheet were indistinguishable.
//
// These tests exist because the fix is easy to undo silently: an event name is
// a string, and a typo in a property key still ships, still validates, and just
// quietly reports nothing. They assert the shape of the properties, not merely
// that track() was called.

let trackCalls = [];
let saveMealResult = { id: 'm1', lines: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }] };
let logSavedMealResult = { logged: 3, skipped: [], meal: 'Usual breakfast' };
let saveIntakeResult = { written: true, skipped: null, weightWritten: true };
let foodRequestResult = { request: { id: 'r1', name: 'Momos, steamed', requestCount: 1, createdAt: 'now' }, created: true };

let nutritionService;
let intakeService;
let controller;

// Minimal Prisma stand-in. The controller instantiates one at module scope and
// none of the handlers below touch it, because the services are stubbed.
before(async () => {
  const { mock } = await import('node:test');
  const href = (p) => new URL(p, import.meta.url).href;

  trackCalls = [];

  mock.module('@prisma/client', {
    exports: { PrismaClient: class {} },
  });
  mock.module(href('../utils/analytics.js'), {
    exports: {
      track: (...args) => {
        trackCalls.push(args);
      },
    },
  });

  // The whole namespace has to be present, not just the three functions under
  // test: scoreService imports getDayTotals from here, and ESM fails the entire
  // module graph over one missing named export.
  const nutritionStubs = {
    saveMeal: async () => saveMealResult,
    logSavedMeal: async () => logSavedMealResult,
    listSavedMeals: async () => [],
    getDayTotals: async () => ({ kcal: 0 }),
  };
  mock.module(href('../services/ledger/nutritionService.js'), {
    exports: nutritionStubs,
  });

  intakeService = {
    saveIntake: async () => saveIntakeResult,
    getSetupState: async () => ({ missing: [] }),
  };
  mock.module(href('../services/ledger/ledgerIntakeService.js'), {
    exports: intakeService,
  });

  foodRequestResult = { request: { id: 'r1', name: 'Momos, steamed', requestCount: 1, createdAt: 'now' }, created: true };
  mock.module(href('../services/ledger/foodRequestService.js'), {
    exports: {
      // Echoes the name back rather than returning a fixed one, because the
      // event carries the row's name and a stub that ignored its input would
      // make the assertion below pass for the wrong reason.
      requestFood: async (_prisma, { name }) => ({
        request: { ...foodRequestResult.request, name },
        created: foodRequestResult.created,
      }),
      listRequests: async () => [],
      listQueue: async () => [],
      resolveRequest: async () => ({ id: 'r1', name: 'Momos, steamed', status: 'resolved' }),
    },
  });

  controller = await import('../controllers/ledgerController.js');
});

const res = () => {
  const out = { statusCode: 200, body: undefined };
  return {
    out,
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(body) {
      out.body = body;
      return out;
    },
  };
};

const lastEvent = (name) => trackCalls.filter((c) => c[0] === name).pop();
const eventCount = (name) => trackCalls.filter((c) => c[0] === name).length;

const req = (over = {}) => ({ userId: 'u1', body: {}, params: {}, query: {}, ...over });

test('saving a meal emits health_saved_meal_created with the slot and line count', async () => {
  trackCalls = [];
  const r = res();
  await controller.saveMeal(
    req({ body: { name: 'Usual breakfast', slot: 'breakfast', localDate: '2026-09-29' } }),
    r,
  );

  const ev = lastEvent('health_saved_meal_created');
  assert.ok(ev, 'expected a health_saved_meal_created event');
  assert.equal(ev[1], 'u1', 'the event must be attributed to the caller');
  assert.deepEqual(ev[2], { slot: 'breakfast', line_count: 3 });
});

test('a saved meal with no lines reports 0 rather than null', async () => {
  // An empty meal is not a user error - the picker blocks it - but if one ever
  // arrives, a 0 is honest and a null is indistinguishable from "we did not
  // look", which would quietly inflate the average line count.
  trackCalls = [];
  saveMealResult = { id: 'm2', lines: [] };
  await controller.saveMeal(req({ body: { name: 'Nothing', slot: 'lunch' } }), res());

  assert.equal(lastEvent('health_saved_meal_created')[2].line_count, 0);
  saveMealResult = { id: 'm1', lines: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }] };
});

test('repeating a meal logs foods with source saved_meal and both counts', async () => {
  trackCalls = [];
  const r = res();
  await controller.logSavedMeal(
    req({ params: { id: 'm1' }, body: { localDate: '2026-09-29', slot: 'breakfast' } }),
    r,
  );

  const ev = lastEvent('health_food_logged');
  assert.ok(ev, 'a repeat must reach the same foods-logged funnel as a search');
  assert.deepEqual(ev[2], {
    slot: 'breakfast',
    source: 'saved_meal',
    logged_count: 3,
    skipped_count: 0,
  });
});

test('a partial repeat reports what was skipped, not just that it worked', async () => {
  // The server drops foods deleted from the catalogue and returns them in
  // `skipped`; the client shows a partial-write warning naming them. Counting
  // this as a clean repeat would make catalogue rot look like user success.
  trackCalls = [];
  logSavedMealResult = { logged: 2, skipped: ['Paneer', 'Egg'], meal: 'Usual breakfast' };
  const r = res();
  await controller.logSavedMeal(
    req({ params: { id: 'm1' }, body: { localDate: '2026-09-29', slot: 'breakfast' } }),
    r,
  );

  const ev = lastEvent('health_food_logged');
  assert.equal(ev[2].logged_count, 2);
  assert.equal(ev[2].skipped_count, 2, 'two foods were dropped and must be visible as two');
  // The names themselves are the user's data; only the count is a property.
  assert.equal(JSON.stringify(ev[2]).includes('Paneer'), false);
  logSavedMealResult = { logged: 3, skipped: [], meal: 'Usual breakfast' };
});

test('a refused pace is recorded even though nothing was saved', async () => {
  // health_intake_saved only fires on success, so a user our own safety cap
  // turned away looks identical to one who abandoned the wizard. This is the
  // event that separates them - and limited_by says which bound actually
  // applied, so a cap that is too tight for most users is visible rather than
  // a matter of opinion.
  trackCalls = [];
  saveIntakeResult = {
    written: false,
    skipped: 'target_too_aggressive',
    pace: {
      code: 'TARGET_TOO_AGGRESSIVE',
      message: 'That is faster than is safe.',
      earliestDate: '2026-12-01',
      weeksNeeded: 9,
      maxWeeklyLossKg: 0.75,
      limitedBy: 'max_weekly_loss_0.75kg',
    },
  };

  const r = res();
  await controller.saveSetup(req({ body: { targetDate: '2026-10-05' } }), r);

  assert.equal(r.out.statusCode, 422, 'a refusal is still a 422');
  assert.equal(eventCount('health_intake_saved'), 0, 'nothing was saved, so nothing was saved');
  const ev = lastEvent('health_targets_pace_rejected');
  assert.ok(ev, 'the refusal itself is the signal');
  assert.deepEqual(ev[2], {
    code: 'TARGET_TOO_AGGRESSIVE',
    limited_by: 'max_weekly_loss_0.75kg',
    weeks_needed: 9,
    max_weekly_loss_kg: 0.75,
  });
});

// ---- The missing-food request flow -----------------------------------------
//
// These rows are the only record of what people searched for and could not find,
// so they are the catalogue growth backlog. The analytics event is a second,
// independent copy of that signal, and the two must not be confused.

test('a new food request emits health_food_requested', async () => {
  trackCalls = [];
  const r = res();
  await controller.requestFood(req({ body: { name: 'Momos, steamed' } }), r);

  const ev = lastEvent('health_food_requested');
  assert.ok(ev, 'expected a health_food_requested event');
  assert.equal(ev[1], 'u1');
  assert.deepEqual(ev[2], { name: 'Momos, steamed' });
});

test('a repeat ask emits nothing - the row count is the demand signal', async () => {
  // requestCount on the row already counts it. Emitting here too would make one
  // persistent user look like growing demand, which is the one conclusion this
  // event is supposed to support.
  trackCalls = [];
  foodRequestResult = { request: { id: 'r1', name: 'Momos, steamed', requestCount: 4, createdAt: 'now' }, created: false };
  const r = res();
  await controller.requestFood(req({ body: { name: 'Momos, steamed' } }), r);

  assert.equal(eventCount('health_food_requested'), 0, 'a repeat is not a new request');
  // And the client still needs the count to say something useful, which is why
  // `created: false` is in the body rather than the event.
  assert.equal(r.out.body.data.created, false);
  assert.equal(r.out.body.data.requestCount, 4);
  foodRequestResult = { request: { id: 'r1', name: 'Momos, steamed', requestCount: 1, createdAt: 'now' }, created: true };
});

test('reviewing a request emits no analytics event at all', async () => {
  // The reviewer is staff, not a user, and the decision is already in the row.
  // Counting it here would mix internal triage into a user-behaviour funnel.
  trackCalls = [];
  await controller.resolveFoodRequest(
    req({ params: { id: 'r1' }, body: { status: 'resolved', reviewNote: 'seeded' } }),
    res(),
  );
  assert.equal(trackCalls.length, 0);
});

test('the request name is carried, unlike a photo\'s proposed names', async () => {
  // Deliberate asymmetry, and the event dictionary says so. A photo's proposed
  // names are a description of somebody's plate; a food name is not. The whole
  // value of this event is knowing WHICH dish, so dropping the name would leave
  // a count of requests with nothing to act on.
  trackCalls = [];
  await controller.requestFood(req({ body: { name: 'Chole bhature' } }), res());
  assert.ok(JSON.stringify(lastEvent('health_food_requested')[2]).includes('Chole bhature'));
});

test('an accepted intake still emits only the success event', async () => {
  trackCalls = [];
  saveIntakeResult = { written: true, skipped: null, weightWritten: true };
  const r = res();
  await controller.saveSetup(req({ body: { weightKg: 82 } }), r);

  assert.equal(r.out.statusCode, 200);
  assert.equal(eventCount('health_targets_pace_rejected'), 0);
  const ev = lastEvent('health_intake_saved');
  assert.deepEqual(ev[2], { skipped: null, hasGoal: true, weightWritten: true });
  assert.equal(
    JSON.stringify(ev[2]).includes('82'),
    false,
    'a body weight is not an analytics property',
  );
});
