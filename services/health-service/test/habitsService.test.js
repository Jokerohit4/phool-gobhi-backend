// The daily habits (B11): water and supplements.
//
// What is pinned here:
//   - the water target comes from the SAME source the prescription read uses
//     (currentNutritionTarget), falling back to the journey default when no
//     target exists — the habits screen and the Plan tab must never disagree
//     about what "enough" means;
//   - a drink is 50-2000 ml, an integer, per entry — the per-entry cap is what
//     makes "logged 4 L" impossible to fake with one tap;
//   - every day query is validated YYYY-MM-DD, because a malformed localDate
//     would write rows no day query could ever match (isoDay.js);
//   - names are trimmed to 1-60 characters, times are real HH:MM clock values,
//     and the schedule list caps at 10;
//   - deleting (a drink, a schedule) is idempotent and scoped to the owner —
//     a missing row, a double tap and someone else's row all end in the same
//     204, and a schedule's tick history outlives the schedule;
//   - a taken-tick is idempotent per day: the second tap returns the first
//     tick instead of writing a second row that an export would read as a
//     second dose.
//
// The fake prisma filters by the `where` it is given, so "only that user's
// rows for that day" is actually tested rather than assumed. Run with:
// node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

let svc;

test('setup: import habitsService (pure imports - no prisma mock needed)', async (t) => {
  t.mock.module('../services/plan/rebuildPlan.js', {
    namedExports: {
      rebuildPlan: async () => ({ created: 0, updated: 0, deleted: 0 }),
    },
  });
  svc = await import('../services/habitsService.js');
  assert.equal(typeof svc.getToday, 'function');
});

// ---- fake prisma ------------------------------------------------------------

function matches(where, row) {
  return Object.entries(where || {}).every(([k, v]) => {
    if (v === null || v === undefined) return row[k] === v;
    return row[k] === v;
  });
}

function fakePrisma() {
  const state = {
    waterLogs: [], // {id, userId, localDate, ml, createdAt}
    schedules: [], // {id, userId, name, times, active, createdAt, updatedAt}
    logs: [], // {id, userId, scheduleId, name, localDate, takenAt}
    nutritionTargets: [], // newest effectiveFrom wins (currentTarget contract)
  };
  let nextId = 1;

  const prisma = {
    state,
    waterLog: {
      findMany: async ({ where, orderBy } = {}) => {
        const rows = state.waterLogs.filter((r) => matches(where, r));
        if (orderBy?.id === 'asc') rows.sort((a, b) => a.id - b.id);
        return rows;
      },
      create: async ({ data }) => {
        const row = { id: nextId++, createdAt: new Date(), ...data };
        state.waterLogs.push(row);
        return row;
      },
      aggregate: async ({ _sum, where } = {}) => {
        const rows = state.waterLogs.filter((r) => matches(where, r));
        return { _sum: { ml: rows.reduce((s, r) => s + r.ml, 0) } };
      },
      deleteMany: async ({ where } = {}) => {
        const before = state.waterLogs.length;
        state.waterLogs = state.waterLogs.filter((r) => !matches(where, r));
        return { count: before - state.waterLogs.length };
      },
    },
    supplementSchedule: {
      findMany: async ({ where, orderBy } = {}) => {
        const rows = state.schedules.filter((r) => matches(where, r));
        if (orderBy?.id === 'asc') rows.sort((a, b) => a.id - b.id);
        return rows;
      },
      findFirst: async ({ where } = {}) => state.schedules.find((r) => matches(where, r)) || null,
      count: async ({ where } = {}) => state.schedules.filter((r) => matches(where, r)).length,
      create: async ({ data }) => {
        const row = {
          id: nextId++,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.schedules.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.schedules.find((r) => r.id === (where?.id ?? where?.userId));
        if (!row) throw new Error('record not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      deleteMany: async ({ where } = {}) => {
        const before = state.schedules.length;
        state.schedules = state.schedules.filter((r) => !matches(where, r));
        return { count: before - state.schedules.length };
      },
    },
    supplementLog: {
      findMany: async ({ where } = {}) => state.logs.filter((r) => matches(where, r)),
      findFirst: async ({ where } = {}) => state.logs.find((r) => matches(where, r)) || null,
      create: async ({ data }) => {
        const row = { id: nextId++, takenAt: new Date(), ...data };
        state.logs.push(row);
        return row;
      },
    },
    nutritionTarget: {
      findFirst: async ({ orderBy } = {}) => {
        const rows = [...state.nutritionTargets].sort(
          (a, b) => (orderBy?.effectiveFrom === 'desc' ? (a.effectiveFrom < b.effectiveFrom ? 1 : -1) : 0),
        );
        return rows[0] || null;
      },
    },
  };
  return prisma;
}

async function addSchedule(prisma, userId, name, times = []) {
  return svc.createSupplement(prisma, { userId, name, times });
}

// ---- getToday -----------------------------------------------------------------

test('getToday: the water target follows the prescription target, and 2500 when there is none', async () => {
  const prisma = fakePrisma();
  assert.equal((await svc.getToday(prisma, { userId: 7 })).water.targetMl, 2500,
    'no target yet - the journey default applies');

  prisma.state.nutritionTargets.push({ userId: 7, waterMl: 3100, effectiveFrom: '2026-10-01' });
  assert.equal((await svc.getToday(prisma, { userId: 7 })).water.targetMl, 3100,
    'the prescription figure is the figure the habits screen shows');

  // Newest effectiveFrom wins, per currentTarget's contract.
  prisma.state.nutritionTargets.push({ userId: 7, waterMl: 2800, effectiveFrom: '2026-10-05' });
  assert.equal((await svc.getToday(prisma, { userId: 7 })).water.targetMl, 2800);
});

test('getToday: loggedMl sums only that user\'s rows for that day, logs carry id and ml', async () => {
  const prisma = fakePrisma();
  await svc.logWater(prisma, { userId: 7, ml: 250, localDate: '2026-10-10' });
  await svc.logWater(prisma, { userId: 7, ml: 500, localDate: '2026-10-10' });
  await svc.logWater(prisma, { userId: 7, ml: 300, localDate: '2026-10-11' });
  await svc.logWater(prisma, { userId: 8, ml: 999, localDate: '2026-10-10' });

  const { water } = await svc.getToday(prisma, { userId: 7, localDate: '2026-10-10' });
  assert.equal(water.loggedMl, 750, 'another day and another user must not leak in');
  assert.deepEqual(water.logs, [{ id: 1, ml: 250 }, { id: 2, ml: 500 }]);
});

test('getToday: takenToday is per schedule and per day', async () => {
  const prisma = fakePrisma();
  const a = await addSchedule(prisma, 7, 'Vitamin D', ['08:00']);
  const b = await addSchedule(prisma, 7, 'Omega 3', ['21:30']);
  await svc.markTaken(prisma, { userId: 7, id: a.id, localDate: '2026-10-10' });

  let { supplements } = await svc.getToday(prisma, { userId: 7, localDate: '2026-10-10' });
  assert.deepEqual(supplements, [
    { id: a.id, name: 'Vitamin D', times: ['08:00'], takenToday: true },
    { id: b.id, name: 'Omega 3', times: ['21:30'], takenToday: false },
  ]);

  // The next day, the tick does not carry over.
  ({ supplements } = await svc.getToday(prisma, { userId: 7, localDate: '2026-10-11' }));
  assert.equal(supplements.find((s) => s.id === a.id).takenToday, false);
});

test('getToday: a missing localDate means the server\'s IST today', async () => {
  const prisma = fakePrisma();
  await svc.logWater(prisma, { userId: 7, ml: 250, localDate: TODAY });
  const { water } = await svc.getToday(prisma, { userId: 7 });
  assert.equal(water.loggedMl, 250);
});

test('getToday: a malformed localDate is refused before anything is read', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => svc.getToday(prisma, { userId: 7, localDate: '10/10/2026' }),
    (err) => err.status === 400 && err.code === 'INVALID_DATE',
  );
});

// ---- logWater -----------------------------------------------------------------

test('logWater: writes the row and returns the day\'s new total', async () => {
  const prisma = fakePrisma();
  const first = await svc.logWater(prisma, { userId: 7, ml: 250, localDate: '2026-10-10' });
  assert.equal(first.loggedMl, 250);
  const second = await svc.logWater(prisma, { userId: 7, ml: 500, localDate: '2026-10-10' });
  assert.equal(second.loggedMl, 750);
  assert.equal(second.id, first.id + 1, 'one row per drink, not a running total');
});

test('logWater: 50 and 2000 are accepted - the bounds are inclusive', async () => {
  const prisma = fakePrisma();
  await svc.logWater(prisma, { userId: 7, ml: 50, localDate: '2026-10-10' });
  await svc.logWater(prisma, { userId: 7, ml: 2000, localDate: '2026-10-10' });
  assert.equal(prisma.state.waterLogs.length, 2);
});

test('logWater: below 50, above 2000, fractional and non-numeric are refused unwritten', async () => {
  for (const ml of [49, 2001, 250.5, null, undefined, NaN]) {
    const prisma = fakePrisma();
    await assert.rejects(
      () => svc.logWater(prisma, { userId: 7, ml, localDate: '2026-10-10' }),
      (err) => err.status === 400 && err.code === 'INVALID_WATER_ML',
      `accepted ml=${String(ml)}`,
    );
    assert.equal(prisma.state.waterLogs.length, 0, `wrote a row for ml=${String(ml)}`);
  }
});

test('logWater: a malformed localDate is refused unwritten; a missing one means today', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => svc.logWater(prisma, { userId: 7, ml: 250, localDate: '2026-13-01' }),
    (err) => err.status === 400 && err.code === 'INVALID_DATE',
  );
  assert.equal(prisma.state.waterLogs.length, 0);

  await svc.logWater(prisma, { userId: 7, ml: 250 });
  assert.equal(prisma.state.waterLogs[0].localDate, TODAY);
});

// ---- deleteWaterLog -----------------------------------------------------------

test('deleteWaterLog: removes the owner\'s row and is idempotent', async () => {
  const prisma = fakePrisma();
  const row = await svc.logWater(prisma, { userId: 7, ml: 250, localDate: '2026-10-10' });

  await svc.deleteWaterLog(prisma, { userId: 7, id: row.id });
  assert.equal(prisma.state.waterLogs.length, 0);

  // A second delete, and a missing id: the same quiet success, never an error.
  await svc.deleteWaterLog(prisma, { userId: 7, id: row.id });
  await svc.deleteWaterLog(prisma, { userId: 7, id: 'not-a-number' });
});

test('deleteWaterLog: another user\'s row is untouched', async () => {
  const prisma = fakePrisma();
  const theirs = await svc.logWater(prisma, { userId: 8, ml: 250, localDate: '2026-10-10' });
  await svc.deleteWaterLog(prisma, { userId: 7, id: theirs.id });
  assert.equal(prisma.state.waterLogs.length, 1);
});

// ---- supplement schedules ------------------------------------------------------

test('createSupplement: the name is trimmed and the row reads back', async () => {
  const prisma = fakePrisma();
  const row = await svc.createSupplement(prisma, { userId: 7, name: '  Vitamin D  ', times: ['08:00'] });
  assert.equal(row.name, 'Vitamin D');
  assert.deepEqual(row.times, ['08:00']);
  assert.equal(row.active, true);
});

test('createSupplement: names outside 1-60 characters (after trim) are refused', async () => {
  for (const name of [undefined, null, 42, '', '   ', 'x'.repeat(61)]) {
    const prisma = fakePrisma();
    await assert.rejects(
      () => svc.createSupplement(prisma, { userId: 7, name, times: [] }),
      (err) => err.status === 400 && err.code === 'INVALID_SUPPLEMENT',
      `accepted name=${String(name)}`,
    );
    assert.equal(prisma.state.schedules.length, 0);
  }
  const ok = fakePrisma();
  await svc.createSupplement(ok, { userId: 7, name: 'x'.repeat(60), times: [] });
});

test('createSupplement: times must be real HH:MM clock values', async () => {
  const bad = ['9:00', '24:30', '0800', '08:60', '08:00 ', 800, null];
  for (const times of [bad, '08:00', 42]) {
    const prisma = fakePrisma();
    await assert.rejects(
      () => svc.createSupplement(prisma, { userId: 7, name: 'Vitamin D', times }),
      (err) => err.status === 400 && err.code === 'INVALID_SUPPLEMENT',
      `accepted times=${JSON.stringify(times)}`,
    );
  }
  const prisma = fakePrisma();
  await svc.createSupplement(prisma, { userId: 7, name: 'Vitamin D', times: ['08:00', '21:30'] });
  await svc.createSupplement(prisma, { userId: 7, name: 'No times given' });
  assert.deepEqual(prisma.state.schedules[1].times, [], 'a missing times list defaults to empty');
});

test('createSupplement: the 11th schedule is refused with SUPPLEMENT_LIMIT', async () => {
  const prisma = fakePrisma();
  for (let i = 0; i < 10; i += 1) {
    await svc.createSupplement(prisma, { userId: 7, name: `Supp ${i}`, times: [] });
  }
  await assert.rejects(
    () => svc.createSupplement(prisma, { userId: 7, name: 'One too many', times: [] }),
    (err) => err.status === 400 && err.code === 'SUPPLEMENT_LIMIT',
  );
  assert.equal(prisma.state.schedules.length, 10);

  // The cap is per user: another user's list is untouched by it.
  await svc.createSupplement(fakePrisma(), { userId: 8, name: 'Fine', times: [] });
});

test('updateSupplement: edits the owner\'s row; a missing or foreign row is 404', async () => {
  const prisma = fakePrisma();
  const row = await addSchedule(prisma, 7, 'Vitamin D', ['08:00']);

  const out = await svc.updateSupplement(prisma, { userId: 7, id: row.id, name: 'Vitamin D3' });
  assert.equal(out.name, 'Vitamin D3');
  assert.deepEqual(out.times, ['08:00'], 'a field the request did not carry is untouched');

  await assert.rejects(
    () => svc.updateSupplement(prisma, { userId: 7, id: row.id + 100, name: 'Nope' }),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => svc.updateSupplement(prisma, { userId: 8, id: row.id, name: 'Not mine' }),
    (err) => err.status === 404,
  );
});

test('updateSupplement: nothing to update is refused', async () => {
  const prisma = fakePrisma();
  const row = await addSchedule(prisma, 7, 'Vitamin D');
  await assert.rejects(
    () => svc.updateSupplement(prisma, { userId: 7, id: row.id }),
    (err) => err.status === 400 && err.code === 'INVALID_SUPPLEMENT',
  );
});

test('deleteSupplement: removes the row, leaves the tick history, idempotent', async () => {
  const prisma = fakePrisma();
  const row = await addSchedule(prisma, 7, 'Vitamin D', ['08:00']);
  await svc.markTaken(prisma, { userId: 7, id: row.id, localDate: '2026-10-10' });

  await svc.deleteSupplement(prisma, { userId: 7, id: row.id });
  assert.equal(prisma.state.schedules.length, 0);
  assert.equal(prisma.state.logs.length, 1, 'the tick outlives the schedule (no relation, by design)');

  // Again, and junk: the same quiet 204 path.
  await svc.deleteSupplement(prisma, { userId: 7, id: row.id });
  await svc.deleteSupplement(prisma, { userId: 7, id: null });
});

test('listSupplements: returns the owner\'s rows, rows only (no taken state)', async () => {
  const prisma = fakePrisma();
  await addSchedule(prisma, 7, 'Vitamin D', ['08:00']);
  await addSchedule(prisma, 8, 'Not mine', ['09:00']);
  await svc.markTaken(prisma, { userId: 7, id: 1, localDate: '2026-10-10' });

  const rows = await svc.listSupplements(prisma, { userId: 7 });
  assert.deepEqual(rows, [{ id: 1, name: 'Vitamin D', times: ['08:00'], active: true }]);
});

// ---- markTaken -----------------------------------------------------------------

test('markTaken: writes a tick carrying the schedule\'s own name', async () => {
  const prisma = fakePrisma();
  const row = await addSchedule(prisma, 7, 'Vitamin D', ['08:00']);

  const tick = await svc.markTaken(prisma, { userId: 7, id: row.id, localDate: '2026-10-10' });
  assert.equal(tick.scheduleId, row.id);
  assert.equal(tick.name, 'Vitamin D');
  assert.equal(tick.localDate, '2026-10-10');
  assert.equal(prisma.state.logs.length, 1);
});

test('markTaken: a second tap on the same day returns the first tick, not a second row', async () => {
  const prisma = fakePrisma();
  const row = await addSchedule(prisma, 7, 'Vitamin D', ['08:00']);
  const first = await svc.markTaken(prisma, { userId: 7, id: row.id, localDate: '2026-10-10' });
  const again = await svc.markTaken(prisma, { userId: 7, id: row.id, localDate: '2026-10-10' });

  assert.equal(again.id, first.id);
  assert.equal(prisma.state.logs.length, 1, 'one day, one tick - an export must not read two doses');

  // A different day ticks again.
  await svc.markTaken(prisma, { userId: 7, id: row.id, localDate: '2026-10-11' });
  assert.equal(prisma.state.logs.length, 2);
});

test('markTaken: a missing or foreign schedule is 404; a bad day is 400', async () => {
  const prisma = fakePrisma();
  const row = await addSchedule(prisma, 7, 'Vitamin D');

  await assert.rejects(
    () => svc.markTaken(prisma, { userId: 8, id: row.id, localDate: '2026-10-10' }),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => svc.markTaken(prisma, { userId: 7, id: row.id + 50, localDate: '2026-10-10' }),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => svc.markTaken(prisma, { userId: 7, id: row.id, localDate: 'tomorrow' }),
    (err) => err.status === 400 && err.code === 'INVALID_DATE',
  );
  assert.equal(prisma.state.logs.length, 0);
});
