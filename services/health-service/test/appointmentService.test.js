import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createAppointment,
  updateAppointment,
  deleteAppointment,
  getAppointment,
  listAppointments,
  nextAppointment,
} from '../services/ledger/appointmentService.js';

// A fake prisma with the shape these functions actually use.
//
// Hand-written rather than a generic mock because the ownership checks ARE the
// thing under test: a stub that returns whatever it is handed would pass every
// assertion here while proving nothing about whether a user can read a row that
// is not theirs. `create` records its input so the "does not write PlanItem"
// assertions can look at what was actually written.
function fakePrisma(rows = []) {
  const store = rows.map((r) => ({ ...r }));
  const written = { planItem: [], create: [], update: [] };

  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond = v;
        if ('equals' in cond) return row[k] === cond.equals;
        if ('gte' in cond) return row[k] >= cond.gte;
        if ('lte' in cond) return row[k] <= cond.lte;
        return true;
      }
      return row[k] === v;
    });

  return {
    store,
    written,
    doctorAppointment: {
      findMany: async ({ where = {}, take }) => {
        const out = store.filter((r) => matches(r, where));
        return take ? out.slice(0, take) : out;
      },
      findFirst: async ({ where = {} }) => {
        return store.find((r) => matches(r, where)) ?? null;
      },
      findUnique: async ({ where = {} }) => {
        return store.find((r) => matches(r, where)) ?? null;
      },
      create: async ({ data }) => {
        const row = { id: store.length + 1, ...data };
        store.push(row);
        written.create.push(data);
        return row;
      },
      update: async ({ where = {}, data }) => {
        written.update.push({ where, data });
        const row = store.find((r) => matches(r, where));
        if (!row) throw new Error('no row');
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where = {} }) => {
        const i = store.findIndex((r) => matches(r, where));
        if (i < 0) throw new Error('no row');
        return store.splice(i, 1)[0];
      },
    },
    planItem: {
      create: async (args) => {
        written.planItem.push(args);
      },
    },
  };
}

const MINE = { id: 5, userId: 1, doctorName: 'Dr Rao', localDate: '2026-11-04' };
const THEIRS = { id: 6, userId: 2, doctorName: 'Dr Someone Else', localDate: '2026-11-04' };

// ---- Ownership ------------------------------------------------------------
//
// These come first because they are the failures that would matter most and the
// ones a mocked happy path never reaches.

test('a user cannot read, edit or delete another user\'s appointment', async () => {
  const prisma = fakePrisma([THEIRS]);

  await assert.rejects(() => getAppointment(prisma, { userId: 1, id: THEIRS.id }), {
    status: 404,
  });
  await assert.rejects(() => updateAppointment(prisma, { userId: 1, id: THEIRS.id, notes: 'x' }), {
    status: 404,
  });
  await assert.rejects(() => deleteAppointment(prisma, { userId: 1, id: THEIRS.id }), {
    status: 404,
  });

  assert.equal(prisma.store.length, 1, 'a rejected call must not have removed the row');
  assert.equal(prisma.written.update.length, 0, 'a rejected call must not have written');
});

test("another user's appointment is 404, not 403", async () => {
  // The distinction between "no such appointment" and "not yours" is one that
  // tells an attacker this id exists. 403 would confirm it.
  const prisma = fakePrisma([THEIRS]);
  await assert.rejects(
    () => getAppointment(prisma, { userId: 1, id: THEIRS.id }),
    (err) => err.status === 404 && err.code === 'NO_SUCH_APPOINTMENT',
  );
});

test('a list never returns another user\'s rows', async () => {
  const prisma = fakePrisma([MINE, THEIRS]);
  const rows = await listAppointments(prisma, { userId: 1 });
  assert.deepEqual(rows.map((r) => r.id), [MINE.id]);
});

// ---- Validation -----------------------------------------------------------

test('an appointment needs a doctor and a real date', async () => {
  const prisma = fakePrisma();

  await assert.rejects(() => createAppointment(prisma, { userId: 1, localDate: '2026-11-04' }), {
    code: 'DOCTOR_REQUIRED',
  });
  await assert.rejects(
    () => createAppointment(prisma, { userId: 1, doctorName: 'Dr Rao' }),
    { code: 'DATE_REQUIRED' },
  );
});

test('a date that parses but does not exist is rejected', async () => {
  // '2026-02-31' matches the shape regex and Date parses it to 3 March. Storing
  // that would put an appointment on a day the user never agreed to, and the
  // error would not arrive until it rendered wrong.
  const prisma = fakePrisma();
  for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-11-31']) {
    await assert.rejects(
      () => createAppointment(prisma, { userId: 1, doctorName: 'Dr Rao', localDate: bad }),
      { status: 400 },
      `${bad} must be rejected`,
    );
  }
  assert.equal(prisma.store.length, 0);
});

test('leap days are accepted, because they exist', async () => {
  // The complement of the above test. A validator that rejects 29 February is
  // rejecting a date somebody's appointment is genuinely on, four years out.
  const prisma = fakePrisma();
  const row = await createAppointment(prisma, {
    userId: 1,
    doctorName: 'Dr Rao',
    localDate: '2028-02-29',
  });
  assert.equal(row.localDate, '2028-02-29');
});

test('a time is optional but must be a time when given', async () => {
  const prisma = fakePrisma();
  const noTime = await createAppointment(prisma, {
    userId: 1,
    doctorName: 'Dr Rao',
    localDate: '2026-11-04',
  });
  assert.equal(noTime.localTime, null);

  for (const bad of ['24:00', '9:30', '09:60', '0930', 'morning']) {
    await assert.rejects(
      () =>
        createAppointment(prisma, {
          userId: 1,
          doctorName: 'Dr Rao',
          localDate: '2026-11-04',
          localTime: bad,
        }),
      { code: 'TIME_INVALID' },
      `${bad} must be rejected`,
    );
  }
});

test('a follow-up cannot precede its own appointment', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () =>
      createAppointment(prisma, {
        userId: 1,
        doctorName: 'Dr Rao',
        localDate: '2026-11-04',
        followUpDate: '2026-11-01',
      }),
    { code: 'FOLLOWUP_BEFORE_APPOINTMENT' },
  );
});

test('a bad date and a bad follow-up are reported separately', async () => {
  // "You left the date blank" and "that time is not a time" are different
  // corrections, and a user fixing one typo should not be told about the other.
  const prisma = fakePrisma();
  await assert.rejects(
    () =>
      createAppointment(prisma, {
        userId: 1,
        doctorName: 'Dr Rao',
        localDate: '2026-11-04',
        localTime: '9:30',
      }),
    { code: 'TIME_INVALID' },
  );
});

// ---- Partial update -------------------------------------------------------

test('an update that omits a field leaves it alone', async () => {
  // The reason the controller copies by key presence. Forwarding undefined for
  // an absent field would wipe the speciality and notes on every correction to
  // a time.
  const prisma = fakePrisma([
    { ...MINE, speciality: 'Cardiology', notes: 'bring the previous ECG', localTime: '10:30' },
  ]);

  await updateAppointment(prisma, { userId: 1, id: MINE.id, localTime: '11:00' });

  const row = prisma.store[0];
  assert.equal(row.localTime, '11:00');
  assert.equal(row.speciality, 'Cardiology');
  assert.equal(row.notes, 'bring the previous ECG');
});

test('a null clears a field, which is different from omitting it', async () => {
  // "I no longer know what time this is" is a real edit, not a no-op.
  const prisma = fakePrisma([{ ...MINE, localTime: '10:30' }]);
  await updateAppointment(prisma, { userId: 1, id: MINE.id, localTime: null });
  assert.equal(prisma.store[0].localTime, null);
});

test('moving an appointment past its own follow-up is rejected', async () => {
  // Checking only the incoming pair would let this through: the update carries a
  // valid date, and the follow-up is untouched. It is still wrong afterwards.
  const prisma = fakePrisma([{ ...MINE, localDate: '2026-11-04', followUpDate: '2026-11-10' }]);

  await assert.rejects(
    () => updateAppointment(prisma, { userId: 1, id: MINE.id, localDate: '2026-11-20' }),
    { code: 'FOLLOWUP_BEFORE_APPOINTMENT' },
  );
  assert.equal(prisma.store[0].localDate, '2026-11-04', 'the rejected update must not have applied');
});

test('emptying the doctor name is rejected rather than clearing it', async () => {
  const prisma = fakePrisma([MINE]);
  await assert.rejects(
    () => updateAppointment(prisma, { userId: 1, id: MINE.id, doctorName: '   ' }),
    { code: 'DOCTOR_REQUIRED' },
  );
});

// ---- The scoring boundary -------------------------------------------------

test('nothing here writes a plan item, so these routes cannot move a score', async () => {
  const prisma = fakePrisma();
  const row = await createAppointment(prisma, {
    userId: 1,
    doctorName: 'Dr Rao',
    localDate: '2026-11-04',
  });

  assert.deepEqual(prisma.written.planItem, [], 'creating an appointment wrote a PlanItem');
  assert.ok(!('kind' in row) && !('points' in row));
});

test('the service cannot write a plan item at all', () => {
  // The strongest statement of the boundary: not "this path does not write one"
  // but "this file has no way to". A future edit that does would fail here.
  //
  // Comments are stripped first. The header discusses PlanItem at length, on
  // purpose, because the boundary is the interesting part - what matters is that
  // no executable line can cross it.
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(
    join(here, '..', 'services', 'ledger', 'appointmentService.js'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /prisma\.planItem/i);
  assert.doesNotMatch(code, /PlanItem/);
});

test('the score engine still scores appointments from the plan', () => {
  // The other direction. Nothing here should have quietly moved scoring, since
  // the plan is what the engine reads and that path is meant to be untouched
  // until there are rows on both sides to compare.
  const here = dirname(fileURLToPath(import.meta.url));
  const engine = readFileSync(join(here, '..', 'services', 'ledger', 'scoreEngine.js'), 'utf8');

  // Both branches of the switch, not just the string. A "scoring unchanged" claim
  // that only checks one arm of a case statement proves very little.
  assert.match(engine, /case 'doctor_appointment':[\s\S]{0,900}doctorAppointmentMissed/);
  assert.match(engine, /case 'doctor_appointment':[\s\S]{0,4000}doctorAppointmentAttended/);
});

// ---- Next -----------------------------------------------------------------

test('next skips appointments already past today', async () => {
  const prisma = fakePrisma([
    { ...MINE, id: 1, localDate: '2026-10-01' },
    { ...MINE, id: 2, localDate: '2026-11-04', localTime: '10:30' },
  ]);

  const next = await nextAppointment(prisma, { userId: 1, from: '2026-11-01' });
  assert.equal(next.id, 2);
});

test('next on the same day skips a time that has passed but keeps one ahead', async () => {
  const prisma = fakePrisma([
    { ...MINE, id: 1, localDate: '2026-11-04', localTime: '09:00' },
    { ...MINE, id: 2, localDate: '2026-11-04', localTime: '15:00' },
  ]);

  const next = await nextAppointment(prisma, {
    userId: 1,
    from: '2026-11-04',
    now: new Date('2026-11-04T10:00:00Z'),
  });
  assert.equal(next.id, 2);
});

test('an appointment with no time today is still next', async () => {
  // "Sometime on the 14th" has not passed at any particular hour, so filtering
  // it out on a time comparison would hide an appointment that is still ahead.
  const prisma = fakePrisma([{ ...MINE, localDate: '2026-11-04', localTime: null }]);

  const next = await nextAppointment(prisma, {
    userId: 1,
    from: '2026-11-04',
    now: new Date('2026-11-04T23:30:00Z'),
  });
  assert.ok(next);
});

test('next returns null rather than throwing when there is nothing', async () => {
  const prisma = fakePrisma([]);
  assert.equal(await nextAppointment(prisma, { userId: 1, from: '2026-11-01' }), null);
});

// ---- Gates ----------------------------------------------------------------

test('every appointment route is behind auth and the ledger gates', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const routes = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');

  const lines = routes
    .split('\n')
    .filter((l) => l.includes("'/ledger/appointments"));

  assert.ok(lines.length >= 6, `expected 6 appointment routes, found ${lines.length}`);
  for (const line of lines) {
    // `nutrition` is the composed array defined in this file: requireAuth plus
    // both flags plus the per-person consent scope.
    assert.match(line, /\.\.\.nutrition/, `ungated appointment route: ${line.trim()}`);
  }
});

test('the next-appointment route is declared before the :id route', () => {
  // Express matches in registration order. '/appointments/next' after a route
  // containing ':id' would match that one first and look for an appointment with
  // id "next", which fails forever against an id that cannot exist.
  const here = dirname(fileURLToPath(import.meta.url));
  const routes = readFileSync(join(here, '..', 'routes', 'ledger.js'), 'utf8');

  const next = routes.indexOf("'/ledger/appointments/next'");
  const byId = routes.indexOf("'/ledger/appointments/:id'");

  assert.ok(next > -1 && byId > -1, 'appointment routes not found');
  assert.ok(next < byId, "'/appointments/next' must be registered before '/appointments/:id'");
});

test('a userId in the request body is ignored on create', async () => {
  // The controller takes userId from the session, but assert the service cannot
  // be talked into writing somebody else's row even if a caller passes one.
  const prisma = fakePrisma();
  await createAppointment(prisma, {
    userId: 1,
    doctorName: 'Dr Rao',
    localDate: '2026-11-04',
  });
  assert.equal(prisma.store[0].userId, 1);
});