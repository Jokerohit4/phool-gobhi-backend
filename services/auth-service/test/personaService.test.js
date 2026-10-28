// Persona (services/personaService.js): the resolver every reader uses, and
// the switch. Run against an in-memory Prisma double, like gymLinkService.test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialPersonaFromAnswers,
  resolvePersona,
  appModeForPersona,
  personaForAppMode,
  switchPersona,
  PERSONA_SWITCH_LIMIT,
} from '../services/personaService.js';
import { deriveAppMode } from '../services/appModeService.js';
import { leaveGym, removeMemberFromGym, linkGym } from '../services/gymLinkService.js';
import { PERSONAS, VALID_PERSONAS } from '../constants/userEnums.js';

const DAY = 24 * 60 * 60 * 1000;

// Gym-link events announce persona changes to health/challenge-service
// (personaEvents.js). Nothing is listening here.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// --- in-memory Prisma ---------------------------------------------------------

function matchValue(cond, value) {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond;
  if ('not' in cond) return value !== cond.not;
  if ('in' in cond) return cond.in.includes(value);
  if ('gte' in cond) return value != null && value >= cond.gte;
  return value === cond;
}
function matches(where, row) {
  return Object.entries(where).every(([key, cond]) => matchValue(cond, row[key]));
}
function newest(rows, orderBy) {
  if (!orderBy) return rows[0];
  const [[field, dir]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1))[0];
}

function fakePrisma({ users = [], gymLinks = [], history = [], flags = { personaSwitch: true, selfLinkGym: true } } = {}) {
  const state = { users: users.map((u) => ({ ...u })), gymLinks: gymLinks.map((l) => ({ ...l })), history: history.map((h) => ({ ...h })) };
  let linkId = 100;
  let clock = Date.now();
  const api = {
    user: {
      async findUnique({ where }) { const r = state.users.find((u) => u.id === where.id); return r ? { ...r } : null; },
      async update({ where, data }) { const r = state.users.find((u) => u.id === where.id); Object.assign(r, data); return { ...r }; },
      async updateMany({ where, data }) { const hit = state.users.filter((u) => matches(where, u)); hit.forEach((u) => Object.assign(u, data)); return { count: hit.length }; },
    },
    gymLink: {
      async findFirst({ where, orderBy }) { const r = newest(state.gymLinks.filter((l) => matches(where, l)), orderBy); return r ? { ...r } : null; },
      async findMany({ where }) { return state.gymLinks.filter((l) => matches(where, l)); },
      async create({ data }) { const r = { id: linkId++, removedAt: null, selfRelinkBlocked: false, ...data }; state.gymLinks.push(r); return { ...r }; },
      async updateMany({ where, data }) { const hit = state.gymLinks.filter((l) => matches(where, l)); hit.forEach((l) => Object.assign(l, data)); return { count: hit.length }; },
      async count({ where }) { return state.gymLinks.filter((l) => matches(where, l)).length; },
    },
    userDevice: { async findMany() { return []; } },
    appModeHistory: {
      async findFirst({ where, orderBy }) { const r = newest(state.history.filter((h) => matches(where, h)), orderBy); return r ? { ...r } : null; },
      // Strictly increasing timestamps so "latest" is well defined.
      async create({ data }) { const r = { createdAt: new Date(clock++), ...data }; state.history.push(r); return { ...r }; },
      async count({ where }) { return state.history.filter((h) => matches(where, h)).length; },
    },
    appVersionSetting: {
      async findUnique() {
        return { id: 1, config: { features: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, { enabled: v }])) } };
      },
    },
  };
  api.$transaction = async (fn) => fn(api);
  return { prisma: api, state };
}

const customer = (over = {}) => ({
  id: 1, role: 'customer', persona: null, appMode: null, linkedGymId: null, homeUnclaimedGymId: null,
  pendingGymPromptGymId: null, currentlyWorksOut: null, workoutIntent: null, trainingLocationPref: null,
  wellnessFocuses: [], wellnessDayPattern: null, wellnessSleepPattern: null, wellnessSetupCompleted: false,
  leaderboardOptIn: true, ...over,
});

const deps = {
  partnerGym: async (id) => (id === 7 || id === 8 ? { id, isApproved: true } : id === 9 ? { id, isApproved: false } : null),
  unclaimedGym: async (id) => (id === 50 ? { id } : null),
};

// --- resolver -----------------------------------------------------------------

// The rule challenge-service used (and the app duplicated) before personas
// were stored. initialPersonaFromAnswers must agree with it everywhere except
// the one deliberate correction (doesn't train yet + prefers a gym).
function legacyAudience(p) {
  if (p.linkedGymId != null) return 'linked_gym';
  if (p.homeUnclaimedGymId != null) return 'own_gym';
  if (p.workoutIntent === 'wellness_only' || p.appMode === 'wellness' || p.wellnessSetupCompleted
    || p.wellnessFocuses?.length || p.wellnessDayPattern || p.wellnessSleepPattern) return 'wellness';
  if (['gym', 'fitness_centre'].includes(p.trainingLocationPref)) return 'own_gym';
  if (p.appMode === 'home_track' || p.currentlyWorksOut === true
    || ['home', 'sports', 'other'].includes(p.trainingLocationPref)) return 'home_training';
  return 'explorer';
}

test('initialPersonaFromAnswers matches the legacy rule for every answered combination', () => {
  const prefs = [null, 'home', 'gym', 'fitness_centre', 'sports', 'other'];
  const works = [null, true, false];
  const intents = [null, 'workout', 'wellness_only'];
  for (const linkedGymId of [null, 7]) for (const homeUnclaimedGymId of [null, 50])
  for (const trainingLocationPref of prefs) for (const currentlyWorksOut of works) for (const workoutIntent of intents) {
    const u = customer({ linkedGymId, homeUnclaimedGymId, trainingLocationPref, currentlyWorksOut, workoutIntent });
    u.appMode = deriveAppMode(u);
    const got = initialPersonaFromAnswers(u);
    const legacy = legacyAudience(u);
    if (got === null) {
      // Not enough answered to say. The legacy rule called that explorer.
      assert.equal(legacy, 'explorer', JSON.stringify(u));
      continue;
    }
    // The correction: someone who does not train yet has no gym of their own.
    // They are whatever deriveAppMode already made them — wanting a gym is
    // explorer (marketplace), wanting a fitness centre is home_training.
    if (currentlyWorksOut === false && legacy === 'own_gym' && !linkedGymId && !homeUnclaimedGymId) {
      assert.equal(got, trainingLocationPref === 'gym' ? PERSONAS.EXPLORER : PERSONAS.HOME_TRAINING, JSON.stringify(u));
      continue;
    }
    assert.equal(got, legacy, JSON.stringify(u));
  }
});

test('the persona agrees with the appMode deriveAppMode picked', () => {
  // Older builds branch Home on appMode; a new build on persona. For anyone
  // who has never switched, both must show the same Home.
  for (const trainingLocationPref of [null, 'home', 'gym', 'fitness_centre', 'sports', 'other'])
  for (const currentlyWorksOut of [true, false]) {
    const u = customer({ trainingLocationPref, currentlyWorksOut });
    const mode = deriveAppMode(u);
    const persona = initialPersonaFromAnswers(u);
    if (mode === null) continue;
    assert.equal(appModeForPersona(persona), mode, JSON.stringify(u));
  }
});

test('a stored persona wins over every answer', () => {
  const stuck = customer({ persona: 'home_training', wellnessFocuses: ['sleep'], homeUnclaimedGymId: 50, trainingLocationPref: 'gym' });
  assert.equal(resolvePersona(stuck), PERSONAS.HOME_TRAINING);
});

test('unanswered accounts have no persona', () => {
  assert.equal(resolvePersona(customer()), null);
  assert.equal(resolvePersona(null), null);
});

test('appMode and persona map both ways for the switchable modes', () => {
  for (const mode of ['gym_seeker', 'home_track', 'wellness']) {
    assert.equal(appModeForPersona(personaForAppMode(mode)), mode);
  }
});

// --- switch matrix ------------------------------------------------------------

// A user sitting in each persona, built the way they would really get there.
function userIn(persona) {
  switch (persona) {
    case 'linked_gym': return { user: customer({ linkedGymId: 7, trainingLocationPref: 'gym', currentlyWorksOut: true }), gymLinks: [{ id: 1, userId: 1, gymId: 7, source: 'gym_qr', linkedAt: new Date(Date.now() - 90 * DAY), removedAt: null }] };
    case 'own_gym': return { user: customer({ homeUnclaimedGymId: 50, trainingLocationPref: 'gym', currentlyWorksOut: true }) };
    case 'wellness': return { user: customer({ workoutIntent: 'wellness_only', wellnessFocuses: ['sleep'], wellnessSetupCompleted: true }) };
    case 'home_training': return { user: customer({ currentlyWorksOut: true, trainingLocationPref: 'home' }) };
    case 'explorer': return { user: customer({ currentlyWorksOut: false, trainingLocationPref: 'gym' }) };
    default: throw new Error(persona);
  }
}

for (const from of VALID_PERSONAS) {
  for (const to of VALID_PERSONAS) {
    if (from === to) continue;
    test(`switch ${from} -> ${to}`, async () => {
      const { user, gymLinks = [] } = userIn(from);
      assert.equal(resolvePersona(user), from, 'fixture is in the expected persona');
      const { prisma, state } = fakePrisma({ users: [user], gymLinks });
      const gymId = to === 'linked_gym' ? 8 : undefined;

      const result = await switchPersona(prisma, 1, to, { gymId, source: 'settings' }, deps);
      const after = state.users[0];

      assert.equal(result.changed, true);
      assert.equal(resolvePersona(after), to);
      assert.equal(after.appMode, appModeForPersona(to));
      // Never deletes an answer.
      assert.deepEqual(after.wellnessFocuses, user.wellnessFocuses);
      assert.equal(after.trainingLocationPref, user.trainingLocationPref);
      assert.equal(after.homeUnclaimedGymId, user.homeUnclaimedGymId);
      // Gym link follows the persona.
      const active = state.gymLinks.filter((l) => l.removedAt == null);
      if (to === 'linked_gym') {
        assert.equal(after.linkedGymId, 8);
        assert.deepEqual(active.map((l) => l.gymId), [8]);
      } else {
        assert.equal(after.linkedGymId, null);
        assert.equal(active.length, 0);
      }
      // Exactly one history row, recording both personas.
      assert.equal(state.history.length, 1);
      assert.equal(state.history[0].fromPersona, from);
      assert.equal(state.history[0].toPersona, to);
      assert.equal(state.history[0].source, 'settings');
    });
  }
}

test('switching to the persona you are in pins it without spending a switch', async () => {
  const { user } = userIn('wellness');
  const { prisma, state } = fakePrisma({ users: [user] });
  const result = await switchPersona(prisma, 1, 'wellness', { source: 'settings' }, deps);
  assert.equal(result.changed, false);
  assert.equal(state.users[0].persona, 'wellness');
  assert.equal(state.history.length, 0);
});

test('a switched user stays switched however their old answers look', async () => {
  // The bug this module exists for: wellness answers used to win forever.
  const { user } = userIn('wellness');
  const { prisma, state } = fakePrisma({ users: [user] });
  await switchPersona(prisma, 1, 'home_training', { source: 'settings' }, deps);
  assert.equal(resolvePersona(state.users[0]), 'home_training');
  assert.deepEqual(state.users[0].wellnessFocuses, ['sleep']);
});

test('round trip restores the own gym pin', async () => {
  const { user } = userIn('own_gym');
  const { prisma, state } = fakePrisma({ users: [user] });
  await switchPersona(prisma, 1, 'wellness', {}, deps);
  await switchPersona(prisma, 1, 'own_gym', {}, deps);
  assert.equal(state.users[0].homeUnclaimedGymId, 50);
  assert.equal(resolvePersona(state.users[0]), 'own_gym');
});

test('own_gym can be entered without a pin, or with a real one', async () => {
  const { prisma, state } = fakePrisma({ users: [userIn('home_training').user] });
  await switchPersona(prisma, 1, 'own_gym', {}, deps);
  assert.equal(state.users[0].homeUnclaimedGymId, null);
  await switchPersona(prisma, 1, 'own_gym', { gymId: 50 }, deps);
  assert.equal(state.users[0].homeUnclaimedGymId, 50);
  await assert.rejects(switchPersona(prisma, 1, 'own_gym', { gymId: 51 }, deps), { errorCode: 'GYM_NOT_FOUND' });
});

test('linked_gym needs a real, approved partner gym and the self-link flag', async () => {
  const fresh = () => fakePrisma({ users: [userIn('explorer').user] });
  await assert.rejects(switchPersona(fresh().prisma, 1, 'linked_gym', {}, deps), { errorCode: 'GYM_REQUIRED' });
  await assert.rejects(switchPersona(fresh().prisma, 1, 'linked_gym', { gymId: 404 }, deps), { errorCode: 'GYM_NOT_FOUND' });
  await assert.rejects(switchPersona(fresh().prisma, 1, 'linked_gym', { gymId: 9 }, deps), { errorCode: 'GYM_NOT_FOUND' });
  const flagOff = fakePrisma({ users: [userIn('explorer').user], flags: { personaSwitch: true, selfLinkGym: false } });
  await assert.rejects(switchPersona(flagOff.prisma, 1, 'linked_gym', { gymId: 8 }, deps), { errorCode: 'FLAG_DISABLED' });
});

test('linked_gym honours the gym\'s removal block', async () => {
  const { prisma } = fakePrisma({
    users: [userIn('explorer').user],
    gymLinks: [{ id: 1, userId: 1, gymId: 8, source: 'self', linkedAt: new Date(Date.now() - 60 * DAY), removedAt: new Date(), selfRelinkBlocked: true }],
  });
  await assert.rejects(switchPersona(prisma, 1, 'linked_gym', { gymId: 8 }, deps), { errorCode: 'SELF_LINK_BLOCKED' });
});

test(`a user can switch ${PERSONA_SWITCH_LIMIT} times a week, then waits`, async () => {
  const { prisma } = fakePrisma({ users: [userIn('home_training').user] });
  const path = ['wellness', 'explorer', 'home_training'];
  for (const to of path) await switchPersona(prisma, 1, to, { source: 'settings' }, deps);
  await assert.rejects(switchPersona(prisma, 1, 'wellness', { source: 'settings' }, deps), { errorCode: 'SWITCH_COOLDOWN', status: 429 });
});

test('gym link side effects do not count towards the cooldown', async () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ userId: 1, toPersona: 'explorer', fromPersona: 'linked_gym', source: 'gym_removed', createdAt: new Date(Date.now() - i * 1000) }));
  const { prisma } = fakePrisma({ users: [userIn('explorer').user], history });
  await switchPersona(prisma, 1, 'wellness', { source: 'settings' }, deps);
});

test('invalid persona and non-customers are refused', async () => {
  const { prisma } = fakePrisma({ users: [customer({ role: 'partner' })] });
  await assert.rejects(switchPersona(prisma, 1, 'gym_rat', {}, deps), { errorCode: 'INVALID_PERSONA' });
  await assert.rejects(switchPersona(prisma, 1, 'wellness', {}, deps), { status: 403 });
});

test('moving to wellness drops a pending claim prompt', async () => {
  const { prisma, state } = fakePrisma({ users: [{ ...userIn('own_gym').user, pendingGymPromptGymId: 7 }] });
  await switchPersona(prisma, 1, 'wellness', {}, deps);
  assert.equal(state.users[0].pendingGymPromptGymId, null);
});

// --- gym events ---------------------------------------------------------------

test('leaving a gym returns the user to what they were before linking', async () => {
  const { prisma, state } = fakePrisma({ users: [userIn('home_training').user] });
  await switchPersona(prisma, 1, 'linked_gym', { gymId: 8 }, deps);
  await leaveGym(prisma, 1);
  assert.equal(resolvePersona(state.users[0]), 'home_training');
  assert.equal(state.history.at(-1).source, 'gym_leave');
});

test('a partner removal with no earlier persona lands on explorer, not own_gym', async () => {
  // Linking forces trainingLocationPref to gym; re-deriving would have said own_gym.
  const { user, gymLinks } = userIn('linked_gym');
  const { prisma, state } = fakePrisma({ users: [user], gymLinks });
  await removeMemberFromGym(prisma, 7, 1, 99);
  assert.equal(resolvePersona(state.users[0]), 'explorer');
  assert.equal(state.history.at(-1).source, 'gym_removed');
  assert.equal(state.users[0].gymLinkNotice, 'removed_by_gym');
});

test('a QR link makes the user linked_gym once, and a repeat login writes nothing', async () => {
  const { prisma, state } = fakePrisma({ users: [userIn('wellness').user] });
  await linkGym(prisma, 1, 7, 'gym_qr');
  assert.equal(resolvePersona(state.users[0]), 'linked_gym');
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].fromPersona, 'wellness');
  await linkGym(prisma, 1, 7, 'gym_qr');
  assert.equal(state.history.length, 1);
});
