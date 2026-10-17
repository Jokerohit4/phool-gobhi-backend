/** UB6: real generation, ledger ticks, resolution, Today and frozen scoring.
 * Only storage, the journey/consent boundaries and external I/O are faked.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const USER = 1;
const DATE = '2026-10-16'; // Friday, in the Mon/Wed/Fri prescription.
let fixture, journeyCalls;
let buildToday, buildWeek, resolveDay, rebuildPlan, completeItem, uncompleteItem;
let addUserEnteredItem, getPlanForDate, previewDay, closeDay, computeEarns, computeMisses;
let DAILY_MAX_GAIN, DAILY_MAX_LOSS;
const sum = (lines) => lines.reduce((n, l) => n + l.points, 0);

test('setup: mock storage/external boundaries before importing the real services', async () => {
  const mk = (path, namedExports) => mock.module(new URL(path, import.meta.url).href, { namedExports });
  mock.module('@prisma/client', { namedExports: { PrismaClient: class {} } });
  mk('../services/journey/journeyService.js', {
    getJourney: async () => { journeyCalls++; return fixture.journey; },
    getUnlockedLayerKeys: async () => [],
    getScoringWindow: async () => fixture.journey ? ({
      easyStartUntil: fixture.journey.easyStartUntil,
      inactiveSince: fixture.journey.easeBack ? DATE : null,
      foodEarlyNoPenaltyUntilUnlock: fixture.foodNoPenalty,
    }) : null,
  });
  mk('../services/coachConsentService.js', { hasCoachScopeService: async () => true });
  mk('../services/ledger/ledgerConsentService.js', {
    getNutritionConsentService: async () => ({ granted: true }),
    getMedicalRecordsConsentService: async () => ({ granted: fixture.medical }),
    hasNutritionScopeService: async () => true,
    hasMedicalRecordsScopeService: async () => fixture.medical,
    hasMedicalRecordsConsentService: async () => fixture.medical,
  });
  mk('../middleware/requireFeatureFlag.js', { isFeatureEnabled: async () => true });
  mk('../services/templateService.js', { listTemplatesService: async () => [] });
  mk('../utils/analytics.js', { track: (...event) => fixture.events.push(event) });
  mock.module(new URL('../utils/redisClient.js', import.meta.url).href, {
    defaultExport: { get: async () => null, del: async () => 1, set: async () => 'OK' },
  });
  ({ buildToday, buildWeek } = await import('../services/plan/todayService.js'));
  ({ resolveDay } = await import('../services/plan/rowProgress.js'));
  ({ rebuildPlan } = await import('../services/plan/rebuildPlan.js'));
  ({ completeItem, uncompleteItem, addUserEnteredItem, getPlanForDate } = await import('../services/ledger/ledgerPlanService.js'));
  ({ previewDay, closeDay } = await import('../services/ledger/scoreService.js'));
  ({ computeEarns, computeMisses } = await import('../services/ledger/scoreEngine.js'));
  ({ DAILY_MAX_GAIN, DAILY_MAX_LOSS } = await import('../services/ledger/constants.js'));
});

// A small Prisma storage double: query predicates, projections, relation includes
// and mutations are honoured. Unknown queries fail instead of returning all data.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key.includes('_') && !(key in row)) return matches(row, value);
    const actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, operand]) => {
        if (op === 'in') return operand.includes(actual);
        if (op === 'notIn') return !operand.includes(actual);
        if (op === 'not') return actual !== operand;
        if (op === 'lt') return actual < operand;
        if (op === 'gte') return actual >= operand;
        throw new Error(`Unsupported storage predicate ${key}.${op}`);
      });
    }
    return actual === value;
  });
}
function project(row, select) {
  if (!select) return structuredClone(row);
  return Object.fromEntries(Object.entries(select).map(([key, query]) => [key,
    query === true ? structuredClone(row[key]) : (row[key] ?? [])
      .filter((r) => matches(r, query.where)).map((r) => project(r, query.select)),
  ]));
}
function makeStorage(state) {
  const prisma = {};
  for (const name of Object.keys(state.tables)) {
    const rows = state.tables[name];
    const find = ({ where, orderBy, take, select, include } = {}) => {
      let result = rows.filter((r) => matches(r, where));
      for (const order of (Array.isArray(orderBy) ? [...orderBy].reverse() : [orderBy]).filter(Boolean)) {
        const [key, dir] = Object.entries(order)[0];
        result = [...result].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      if (take) result = result.slice(0, take);
      return result.map((r) => {
        const out = project(r, select);
        if (include?.completions) out.completions = state.tables.planItemCompletion
          .filter((c) => c.planItemId === r.id && matches(c, include.completions.where)).map((c) => structuredClone(c));
        return out;
      });
    };
    prisma[name] = {
      findMany: async (args) => find(args),
      findFirst: async (args) => find(args)[0] ?? null,
      findUnique: async (args) => {
        if (name === 'workoutTemplate') assert.ok(Number.isInteger(args.where.id), 'Prisma needs a real template id');
        assert.notEqual(name, 'nutritionTarget', 'target history must use findFirst, not findUnique(userId)');
        return find(args)[0] ?? null;
      },
      count: async ({ where }) => rows.filter((r) => matches(r, where)).length,
      create: async ({ data }) => {
        const row = { id: state.nextId++, createdAt: new Date(), ...structuredClone(data) };
        rows.push(row); return structuredClone(row);
      },
      update: async ({ where, data }) => {
        const row = rows.find((r) => matches(r, where)); assert.ok(row);
        Object.assign(row, structuredClone(data)); return structuredClone(row);
      },
      upsert: async ({ where, create, update }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? prisma[name].update({ where, data: update }) : prisma[name].create({ data: create });
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) { rows.splice(i, 1); count++; }
        return { count };
      },
    };
  }
  prisma.$transaction = async (fn) => {
    const before = structuredClone(state.tables);
    try { return await fn(prisma); } catch (err) {
      for (const key of Object.keys(before)) state.tables[key].splice(0, state.tables[key].length, ...before[key]);
      throw err;
    }
  };
  return prisma;
}
function session(localDate = DATE, id = 90) {
  return { id, userId: USER, localDate, type: 'strength', startedAt: new Date(`${localDate}T08:00:00Z`),
    endedAt: new Date(`${localDate}T08:30:00Z`), exercises: [{ sets: [{ id: 1, completed: true }] }] };
}
async function setup(t, date = DATE) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${date}T10:00:00Z`) });
  journeyCalls = 0;
  fixture = {
    nextId: 100, events: [], medical: true, foodNoPenalty: false,
    journey: { showedUpDates: ['2026-10-12', DATE], steadyWeeks: 2, easeBack: false, easyStartUntil: null,
      layers: [1, 2, 3, 4, 5].map((layer) => ({ layer, unlocked: true, unlockedAt: '2026-10-01T00:00:00Z' })) },
    tables: {
      coachConsent: [{ userId: USER, revokedAt: null, scopes: ['basic', 'supplements'] }],
      healthGoal: [{ userId: USER, pausedFrom: null, pausedUntil: null }],
      prescription: [{ userId: USER, stepsPerDay: 7000, sleepMinutes: 450,
        workoutSlots: [0, 2, 4].map((weekday) => ({ weekday, templateId: 14, title: 'Full body A' })) }],
      nutritionTarget: [{ userId: USER, effectiveFrom: '2026-10-01', kcal: 1900, proteinG: 110, waterMl: 2500, micros: {} }],
      planItem: [], planItemCompletion: [],
      waterLog: [{ userId: USER, localDate: date, ml: 1200 }],
      dailyActivityMetric: [{ userId: USER, date, steps: 4200 }],
      biometricEntry: [{ userId: USER, localDate: date, metric: 'steps', value: 7000 },
        { userId: USER, localDate: date, metric: 'sleep_minutes', value: 420 }],
      foodLog: [{ userId: USER, localDate: date, slot: 'breakfast', nutrients: { kcal: 820, proteinG: 110 } }],
      workoutSession: [session(date)], supplementLog: [],
      supplementSchedule: [{ id: 3, userId: USER, active: true, name: 'Vitamin D' }],
      workoutTemplate: [{ id: 14, name: 'Full body A', exercises: [{ id: 1 }, { id: 2 }] }],
      scoreDaySnapshot: [{ userId: USER, localDate: '2026-10-01', close: 312 }],
    },
  };
  const prisma = makeStorage(fixture);
  await rebuildPlan(prisma, USER, { reason: 'start' });
  const own = await addUserEnteredItem(prisma, { userId: USER, title: 'Stretch', ownKind: 'habit' });
  const doctor = await addUserEnteredItem(prisma, { userId: USER, title: 'My prescription', kind: 'doctor_medication', fromPrescription: true });
  return { prisma, own, doctor, date };
}
const today = (ctx) => buildToday(ctx.prisma, USER, { localDate: ctx.date });
const tick = (ctx, id, date = ctx.date) => completeItem(ctx.prisma, { userId: USER, itemId: id, localDate: date, today: ctx.date });
const row = (payload, kind) => payload.rows.find((r) => r.kind === kind);

async function agree(ctx) {
  const payload = await today(ctx);
  const resolved = await resolveDay(ctx.prisma, { userId: USER, localDate: ctx.date });
  const preview = await previewDay(ctx.prisma, { userId: USER, localDate: ctx.date, today: ctx.date });
  assert.equal(payload.state, 'active');
  assert.equal(payload.counts.total, payload.rows.length);
  assert.equal(payload.counts.done, payload.rows.filter((r) => r.done).length);
  assert.deepEqual(payload.rows, resolved.rows);
  assert.equal(resolved.target, sum(resolved.rows));
  assert.equal(resolved.earned, resolved.rows.reduce((n, r) => n + (r.earned ?? (r.done ? r.points : 0)), 0));
  if (payload.paused) {
    assert.equal(payload.points, null);
    assert.equal(preview.close, payload.score.open);
    assert.deepEqual(preview.breakdown, []);
  } else {
    assert.deepEqual(payload.points, { earned: resolved.earned, target: resolved.target, bonus: resolved.bonus });
    const positive = preview.breakdown.filter((l) => l.points > 0);
    const bonus = positive.filter((l) => ['workout_unplanned', 'micros_met'].includes(l.key));
    assert.equal(sum(positive) - sum(bonus), payload.points.earned, 'earned engine lines match Today');
    const engineInputs = { rows: resolved.rows, targets: resolved.nutritionTarget, totals: resolved.totals,
      unplannedWorkout: resolved.unplannedWorkout, localDate: ctx.date, unlockedLayerKeys: resolved.onLayerKeys };
    assert.deepEqual(computeEarns(engineInputs).map((l) => l.points), preview.breakdown.map((l) => l.points));
    assert.equal(computeMisses({ ...engineInputs, noMisses: true }).length, 0);
    assert.equal(sum(bonus), payload.points.bonus);
    assert.equal(preview.earned, payload.points.earned);
    assert.equal(preview.bonus, payload.points.bonus);
    assert.equal(payload.score.live, payload.score.open + payload.points.earned + payload.points.bonus);
    assert.equal(preview.close, payload.score.live);
    assert.equal(preview.breakdown.some((l) => l.points < 0), false);
  }
  return { payload, resolved, preview };
}
async function freeze(ctx) {
  const before = await agree(ctx);
  const closed = await closeDay(ctx.prisma, { userId: USER, localDate: ctx.date, today: ctx.date });
  const gains = sum(closed.breakdown.filter((l) => l.points > 0));
  const losses = sum(closed.breakdown.filter((l) => l.points < 0));
  assert.equal(gains, before.payload.paused ? 0 : before.resolved.earned + before.resolved.bonus);
  assert.equal(closed.close, closed.open + Math.min(gains, DAILY_MAX_GAIN) + Math.max(losses, -DAILY_MAX_LOSS));
  assert.equal(closed.high, closed.open + Math.min(gains, DAILY_MAX_GAIN));
  assert.equal(closed.low, closed.open + Math.max(losses, -DAILY_MAX_LOSS));
  assert.deepEqual(closed.openActions, []);
  const saved = fixture.tables.scoreDaySnapshot.find((s) => s.localDate === ctx.date);
  assert.equal(saved.close, closed.close);
  assert.deepEqual(saved.breakdown, closed.breakdown);
  fixture.tables.foodLog.length = 0;
  fixture.tables.planItemCompletion.length = 0;
  assert.equal((await closeDay(ctx.prisma, { userId: USER, localDate: ctx.date, today: ctx.date })).close, closed.close);
  return { ...before, closed };
}

test('regular day: automatic progress, manual tick, engine preview and frozen close agree', async (t) => {
  const ctx = await setup(t);
  const before = await agree(ctx);
  assert.equal(before.payload.points.earned, 30); // workout 15, steps 5, protein 10
  assert.equal(row(before.payload, 'water').progress, 0.48);
  assert.equal(row(before.payload, 'workout').how, 'auto');
  assert.equal(row(before.payload, 'workout').templateId, 14);
  assert.equal(row(before.payload, 'workout').moves, 2);
  assert.equal(before.payload.session.today.moves, 2);
  assert.equal(before.payload.session.today.done, true);
  assert.ok(before.preview.openActions.find((a) => a.itemId === ctx.doctor.id));
  assert.ok(before.preview.openActions.find((a) => a.itemId === row(before.payload, 'water').itemId));
  assert.equal(row(before.payload, 'supplement').done, false);
  journeyCalls = 0;
  await today(ctx);
  assert.equal(journeyCalls, 1, 'Today loads the journey once');
  await tick(ctx, ctx.own.id);
  const after = await agree(ctx);
  assert.equal(after.payload.points.earned, before.payload.points.earned + 5);
  assert.equal(row(after.payload, 'own').how, 'tick');
  await tick(ctx, row(after.payload, 'workout').itemId);
  assert.equal((await today(ctx)).points.earned, after.payload.points.earned, 'manual + auto counts once');
  assert.equal(fixture.tables.planItemCompletion[0].how, 'manual');
  assert.equal(after.payload.points.target, 75);
  assert.deepEqual(after.payload.rows.map((r) => r.kind), ['workout', 'water', 'food', 'steps', 'sleep', 'supplement', 'doctor', 'own']);
  const { closed } = await freeze(ctx);
  assert.equal(closed.close, 320); // 312 + 35 - (3 water + 3 sleep + 3 supplement + 10 doctor + 8 kcal)
});

test('same-day settings rebuild keeps suggested and own ticks, ids and earnings', async (t) => {
  const ctx = await setup(t);
  const water = fixture.tables.planItem.find((r) => r.layerKey === 'water');
  await tick(ctx, ctx.own.id); await tick(ctx, water.id);
  const before = await agree(ctx);
  fixture.tables.nutritionTarget[0].waterMl = 3000;
  fixture.tables.prescription[0].stepsPerDay = 7500;
  const result = await rebuildPlan(ctx.prisma, USER, { reason: 'edit' });
  assert.equal(result.updated, 2);
  assert.equal(result.created, 0); assert.equal(result.deactivated, 0);
  // Keep steps met while changing the saved target.
  fixture.tables.biometricEntry[0].value = 7500;
  const after = await agree(ctx);
  assert.equal(row(after.payload, 'water').itemId, water.id);
  assert.equal(row(after.payload, 'water').target, 3000);
  assert.equal(row(after.payload, 'water').how, 'tick');
  assert.equal(row(after.payload, 'water').progress, 1);
  assert.equal(row(after.payload, 'steps').target, 7500);
  assert.equal(after.payload.points.earned, before.payload.points.earned);
  assert.equal(fixture.tables.planItemCompletion.length, 2);
  assert.deepEqual(await rebuildPlan(ctx.prisma, USER, { reason: 'edit' }), { created: 0, updated: 0, deactivated: 0, onLayerKeys: result.onLayerKeys });
  await freeze(ctx);
});

test('rest earns +5 and a qualifying unplanned workout adds one +8 bonus', async (t) => {
  const ctx = await setup(t, '2026-10-17');
  fixture.tables.workoutSession.length = 0;
  const resting = await agree(ctx);
  assert.equal(resting.payload.points.bonus, 0);
  assert.equal(row(resting.payload, 'rest').earned, 5);
  fixture.tables.workoutSession.push(session(ctx.date));
  const { payload } = await agree(ctx);
  assert.equal(row(payload, 'rest').points, 5);
  assert.equal(row(payload, 'rest').done, true);
  assert.equal(payload.points.bonus, 8);
  assert.equal(payload.session.today, null);
  fixture.tables.workoutSession.push(session(ctx.date, 91));
  assert.equal((await today(ctx)).points.bonus, 8);
  await freeze(ctx);
});

test('second qualifying session adds +8 on a workout day; unfinished/short/rest sessions do not', async (t) => {
  const ctx = await setup(t);
  assert.equal((await today(ctx)).points.bonus, 0);
  fixture.tables.workoutSession.push({ ...session(), id: 91, endedAt: null },
    { ...session(), id: 92, exercises: [], endedAt: new Date(`${DATE}T08:05:00Z`) },
    { ...session(), id: 93, type: 'rest' },
    { ...session(), id: 95, exercises: [{ sets: [{ id: 1, completed: false }] }] });
  assert.equal((await today(ctx)).points.bonus, 0);
  fixture.tables.workoutSession.push(session(DATE, 94));
  assert.equal((await today(ctx)).points.bonus, 8);
  await freeze(ctx);
});

test('paused day retains rows and saves ticks while preview and frozen score stay flat', async (t) => {
  const ctx = await setup(t);
  Object.assign(fixture.tables.healthGoal[0], { pausedFrom: DATE, pausedUntil: '2026-10-20' });
  const before = await agree(ctx);
  await tick(ctx, ctx.own.id);
  const after = await agree(ctx);
  assert.equal(row(before.payload, 'own').done, false);
  assert.equal(row(after.payload, 'own').done, true);
  assert.equal(fixture.tables.planItemCompletion.length, 1);
  const { closed } = await freeze(ctx);
  assert.equal(closed.paused, true); assert.equal(closed.close, 312);
});

for (const date of [DATE, '2026-10-17']) test(`incomplete sets earn no workout or bonus on ${date}, regardless of duration`, async (t) => {
  const ctx = await setup(t, date);
  fixture.tables.workoutSession[0].exercises = [{ sets: [{ id: 1, completed: false }] }];
  const { payload, closed } = await freeze(ctx);
  assert.equal(payload.points.bonus, 0);
  assert.equal(closed.breakdown.find((l) => l.key === 'workout_unplanned'), undefined);
  if (date === DATE) {
    assert.equal(row(payload, 'workout').done, false);
    assert.equal(closed.breakdown.find((l) => l.key === 'workout_missed').points, -15);
  } else {
    assert.equal(row(payload, 'rest').earned, 5);
  }
});

test('completed-set and no-set duration boundaries agree from Today through frozen scoring', async (t) => {
  const ctx = await setup(t);
  const sessionRow = fixture.tables.workoutSession[0];
  sessionRow.endedAt = new Date(`${DATE}T08:01:00Z`);
  assert.equal(row((await agree(ctx)).payload, 'workout').earned, 15);
  sessionRow.exercises = [];
  sessionRow.endedAt = new Date(`${DATE}T08:09:59Z`);
  assert.equal(row((await agree(ctx)).payload, 'workout').done, false);
  sessionRow.endedAt = new Date(`${DATE}T08:10:00Z`);
  const { payload } = await freeze(ctx);
  assert.equal(row(payload, 'workout').earned, 15);
  assert.equal(payload.points.bonus, 0);
});

test('easy start and ease-back keep earnings and suppress all close-day misses', async (t) => {
  const ctx = await setup(t);
  fixture.journey.easyStartUntil = '2026-10-28';
  await tick(ctx, ctx.own.id);
  let out = await agree(ctx);
  assert.equal(out.payload.noMisses, true);
  const closed = await closeDay(ctx.prisma, { userId: USER, localDate: DATE, today: DATE });
  assert.equal(closed.close, out.payload.score.live);
  assert.equal(closed.breakdown.some((l) => l.points < 0), false);
  fixture.tables.scoreDaySnapshot.pop();
  fixture.journey.easyStartUntil = null; fixture.journey.easeBack = true;
  out = await freeze(ctx);
  assert.equal(out.payload.noMisses, true);
  assert.equal(out.closed.breakdown.some((l) => l.points < 0), false);
});

test('food row counts once, uses distinct main meals, and shares engine food/bonus rules', async (t) => {
  const ctx = await setup(t);
  fixture.tables.foodLog.splice(0, 1, ...['breakfast', 'breakfast', 'breakfast'].map((slot) => ({ userId: USER, localDate: DATE, slot, nutrients: { kcal: 630, proteinG: 37 } })));
  let out = await agree(ctx);
  assert.equal(row(out.payload, 'food').earned, 20, 'three foods at breakfast are not three meals');
  assert.equal(row(out.payload, 'food').done, false);
  fixture.tables.foodLog[1].slot = 'lunch'; fixture.tables.foodLog[2].slot = 'dinner';
  fixture.tables.nutritionTarget[0].micros = { iron: 1, calcium: 1, zinc: 1, magnesium: 1, vitamin_d: 1, vitamin_b12: 1 };
  Object.assign(fixture.tables.foodLog[0].nutrients, { iron: 2, calcium: 2, zinc: 2, magnesium: 2, vitamin_d: 2, vitamin_b12: 2 });
  out = await agree(ctx);
  assert.equal(row(out.payload, 'food').earned, 25);
  assert.equal(row(out.payload, 'food').done, true);
  assert.equal(out.payload.points.bonus, 10);
  fixture.tables.nutritionTarget[0].proteinG = null;
  out = await agree(ctx); assert.equal(row(out.payload, 'food').points, 15);
  await freeze(ctx);
});

test('gain and loss caps apply only to frozen scores, with no automatic double credit', async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 8; i++) {
    const item = await addUserEnteredItem(ctx.prisma, { userId: USER, title: `Extra ${i}`, ownKind: 'workout' });
    await tick(ctx, item.id);
  }
  const { payload, closed } = await freeze(ctx);
  assert.ok(payload.points.earned > 60);
  assert.equal(closed.close - closed.open, 60 - 30); // own habit, doctor, water, sleep, supplement, calories
});

test('loss cap is applied to actual resolved misses', async (t) => {
  const ctx = await setup(t);
  fixture.tables.workoutSession.length = 0;
  fixture.tables.biometricEntry.length = 0;
  fixture.tables.foodLog.length = 0;
  const { closed } = await freeze(ctx);
  assert.equal(closed.close - closed.open, -40);
  assert.ok(sum(closed.breakdown.filter((l) => l.points < 0)) < -40);
});

test('food early protection preserves existing no-meals exemption at day close', async (t) => {
  const ctx = await setup(t);
  fixture.tables.foodLog.length = 0;
  fixture.foodNoPenalty = true;
  const { closed } = await freeze(ctx);
  assert.equal(closed.breakdown.find((l) => l.key === 'no_meals_logged'), undefined);
  assert.equal(closed.breakdown.find((l) => l.key === 'protein_short').points, -5);
  assert.equal(closed.breakdown.find((l) => l.key === 'calories_off_target').points, -8);
});

test('disabled layers, revoked doctor consent and missing journey cannot earn', async (t) => {
  const ctx = await setup(t);
  fixture.journey.layers = fixture.journey.layers.filter((l) => l.layer === 1);
  fixture.medical = false;
  const { payload, preview } = await agree(ctx);
  assert.deepEqual(payload.rows.map((r) => r.kind), ['workout', 'water', 'own']);
  assert.ok(preview.openActions.find((a) => a.itemId === ctx.own.id));
  assert.equal(payload.points.target, 25);
  fixture.journey = null;
  assert.deepEqual(await today(ctx), { state: 'no_plan', reason: 'no_journey' });
  const closed = await closeDay(ctx.prisma, { userId: USER, localDate: DATE, today: DATE });
  assert.equal(closed.close, closed.open);
  assert.deepEqual(closed.breakdown, []);
});

test('water threshold, supplement log, own-workout tick-only and manual undo use real ledger storage', async (t) => {
  const ctx = await setup(t);
  const ownWorkout = await addUserEnteredItem(ctx.prisma, { userId: USER, title: 'My workout', ownKind: 'workout' });
  fixture.tables.waterLog[0].ml = 2400;
  let out = await agree(ctx);
  assert.equal(row(out.payload, 'water').progress, 0.96);
  assert.equal(row(out.payload, 'water').done, false);
  assert.equal(out.payload.rows.find((r) => r.itemId === ownWorkout.id).done, false);
  fixture.tables.waterLog[0].ml = 2500;
  fixture.tables.supplementLog.push({ userId: USER, localDate: DATE, scheduleId: 3, taken: true });
  out = await agree(ctx);
  assert.equal(row(out.payload, 'water').how, 'auto');
  assert.equal(row(out.payload, 'supplement').how, 'auto');
  assert.equal(fixture.tables.planItemCompletion.length, 0, 'automatic completion never writes ticks');
  await tick(ctx, ownWorkout.id);
  assert.equal((await today(ctx)).points.earned, out.payload.points.earned + 15);
  await uncompleteItem(ctx.prisma, { userId: USER, itemId: ownWorkout.id, localDate: DATE });
  assert.equal((await today(ctx)).points.earned, out.payload.points.earned);
  await assert.rejects(uncompleteItem(ctx.prisma, { userId: USER, itemId: row(out.payload, 'water').itemId, localDate: DATE }), { code: 'AUTO_DONE' });
  await freeze(ctx);
});

test('late ticks save with zero earnings and future ticks are rejected', async (t) => {
  const ctx = await setup(t, '2026-10-17');
  await tick(ctx, ctx.own.id, DATE);
  const plan = await getPlanForDate(ctx.prisma, { userId: USER, localDate: DATE, today: ctx.date });
  assert.equal(plan.items.find((i) => i.id === ctx.own.id).completion.late, true);
  const resolved = await resolveDay(ctx.prisma, { userId: USER, localDate: DATE });
  assert.equal(row(resolved, 'own').done, true);
  assert.equal(row(resolved, 'own').earned, 0);
  fixture.tables.workoutSession.push(session(DATE));
  const workout = fixture.tables.planItem.find((i) => i.kind === 'workout' && i.schedule === '5');
  await tick(ctx, workout.id, DATE);
  const preview = await previewDay(ctx.prisma, { userId: USER, localDate: DATE, today: ctx.date });
  assert.equal(preview.breakdown.find((l) => l.itemId === ctx.own.id).points, 0);
  assert.equal(preview.breakdown.find((l) => l.itemId === workout.id).points, 15, 'a late tick cannot erase a qualifying session');
  await assert.rejects(tick(ctx, ctx.own.id, '2026-10-18'), { status: 400 });
});

for (const [date, monday] of [
  ['2026-10-19', '2026-10-19'], ['2026-10-20', '2026-10-19'], ['2026-10-25', '2026-10-19'],
  ['2026-11-01', '2026-10-26'], ['2027-01-01', '2026-12-28'], ['2026-12-28', '2026-12-28'],
]) test(`week strip ${date} begins Monday ${monday} with exactly one today`, () => {
  const week = buildWeek([date, monday], date);
  assert.equal(week.length, 7); assert.equal(week[0].localDate, monday);
  assert.equal(week.filter((d) => d.isToday).length, 1);
  assert.equal(week.find((d) => d.isToday).localDate, date);
  assert.equal(week.find((d) => d.localDate === date).showedUp, true);
  for (let i = 1; i < 7; i++) assert.equal(Date.parse(week[i].localDate) - Date.parse(week[i - 1].localDate), 86400000);
});
