// PUT /users/:id/persona and the legacy PUT /users/:id/app-mode, through the
// controller with the real personaService against an in-memory Prisma.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

let state;
let flags;

function matches(where, row) {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return row[key] === cond;
    if ('not' in cond) return row[key] !== cond.not;
    if ('in' in cond) return cond.in.includes(row[key]);
    if ('gte' in cond) return row[key] != null && row[key] >= cond.gte;
    return row[key] === cond;
  });
}

function createFakePrisma() {
  const api = {
    user: {
      async findUnique({ where }) { const r = state.users.find((u) => u.id === where.id); return r ? { ...r } : null; },
      async update({ where, data }) { const r = state.users.find((u) => u.id === where.id); Object.assign(r, data); return { ...r }; },
    },
    gymLink: {
      async findFirst({ where }) { const r = state.gymLinks.find((l) => matches(where, l)); return r ? { ...r } : null; },
      async create({ data }) { const r = { id: state.gymLinks.length + 1, removedAt: null, ...data }; state.gymLinks.push(r); return r; },
      async updateMany({ where, data }) { const hit = state.gymLinks.filter((l) => matches(where, l)); hit.forEach((l) => Object.assign(l, data)); return { count: hit.length }; },
      async count({ where }) { return state.gymLinks.filter((l) => matches(where, l)).length; },
    },
    userDevice: { async findMany() { return []; } },
    appModeHistory: {
      async create({ data }) { state.history.push({ createdAt: new Date(), ...data }); return data; },
      async count({ where }) { return state.history.filter((h) => matches(where, h)).length; },
      async findFirst() { return null; },
    },
    appVersionSetting: {
      async findUnique() {
        return { id: 1, config: { features: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, { enabled: v }])) } };
      },
    },
  };
  api.$transaction = async (fn) => fn(api);
  return api;
}

let updatePersona;
let updateAppMode;

test('setup: mock @prisma/client and the gym lookup once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class { constructor() { return createFakePrisma(); } }, Prisma: {} },
  });
  t.mock.module('../services/gymLookup.js', {
    exports: {
      gymLookupDeps: {
        partnerGym: async (id) => (id === 8 ? { id, isApproved: true } : null),
        unclaimedGym: async () => null,
      },
      isLinkablePartnerGym: async () => true,
      isKnownUnclaimedGym: async () => true,
    },
  });
  ({ updatePersona, updateAppMode } = await import('../controllers/userProfileController.js'));
});

function reset(user) {
  state = {
    users: [{ id: 42, role: 'customer', persona: null, appMode: 'wellness', linkedGymId: null, homeUnclaimedGymId: null,
      workoutIntent: 'wellness_only', wellnessFocuses: ['sleep'], wellnessSetupCompleted: true, fitnessGoals: [], ...user }],
    gymLinks: [],
    history: [],
  };
  flags = { personaSwitch: true, selfLinkGym: true };
}

const req = (body, { as = 42 } = {}) => ({ headers: { 'x-user-id': String(as) }, params: { userId: '42' }, body });

test('PUT /persona switches and returns the resolved persona', async () => {
  reset();
  const res = fakeRes();
  await updatePersona(req({ persona: 'home_training', source: 'settings' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.persona, 'home_training');
  assert.equal(res.body.data.appMode, 'home_track');
  assert.equal(res.body.changed, true);
});

test('PUT /persona is 404 while the flag is off', async () => {
  reset();
  flags.personaSwitch = false;
  const res = fakeRes();
  await updatePersona(req({ persona: 'home_training' }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(state.users[0].persona, null);
});

test('PUT /persona only for yourself', async () => {
  reset();
  const res = fakeRes();
  await updatePersona(req({ persona: 'explorer' }, { as: 7 }), res);
  assert.equal(res.statusCode, 403);
});

test('PUT /persona surfaces typed errors as { error, code }', async () => {
  reset();
  const res = fakeRes();
  await updatePersona(req({ persona: 'linked_gym' }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'GYM_REQUIRED');
});

test('PUT /persona to a partner gym links it', async () => {
  reset();
  const res = fakeRes();
  await updatePersona(req({ persona: 'linked_gym', gymId: 8 }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.linkedGymId, 8);
  assert.equal(res.body.data.persona, 'linked_gym');
});

test('legacy app-mode moves the persona too, so the two never disagree', async () => {
  reset();
  const res = fakeRes();
  await updateAppMode(req({ appMode: 'home_track', source: 'floating_prompt' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.users[0].persona, 'home_training');
  assert.equal(state.users[0].appMode, 'home_track');
  assert.equal(state.history[0].source, 'floating_prompt');
});

test('legacy app-mode refuses linked members rather than silently leaving their gym', async () => {
  reset({ linkedGymId: 3, appMode: 'gym_seeker' });
  const res = fakeRes();
  await updateAppMode(req({ appMode: 'home_track' }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'LINKED_GYM');
  assert.equal(state.users[0].linkedGymId, 3);
});
