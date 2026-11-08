// Gym-link HTTP layer (coach-journey B2). Exercises the routes-controller
// contract — auth guards, the self-link flag gate, partner ownership on
// removal, and the 204 shapes — with @prisma/client and the partner-ownership
// lookup mocked so the controller and the real service run together against an
// in-memory store.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

const DAY = 24 * 60 * 60 * 1000;

// Links/leaves announce persona changes to other services (personaEvents.js).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

function matchValue(cond, value) {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond;
  if ('not' in cond) return value !== cond.not;
  if ('in' in cond) return cond.in.includes(value);
  if ('gte' in cond) return value != null && value >= cond.gte;
  if ('lt' in cond) return value != null && value < cond.lt;
  return value === cond;
}
function matches(where, row) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((c) => matches(c, row));
    if (key === 'AND') return cond.every((c) => matches(c, row));
    return matchValue(cond, row[key]);
  });
}

let state;
let flagEnabled;
let assertPartnerOwnsGym;
let partnerOwnsBehavior;

function createFakePrisma() {
  let nextLinkId = 1;
  const api = {
    user: {
      async findUnique({ where }) {
        const row = state.users.find((u) => u.id === where.id);
        return row ? { ...row } : null;
      },
      async findMany({ where }) {
        return state.users.filter((u) => matches(where, u)).map((u) => ({ ...u }));
      },
      async update({ where, data }) {
        const row = state.users.find((u) => u.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async updateMany({ where, data }) {
        const hit = state.users.filter((u) => matches(where, u));
        hit.forEach((u) => Object.assign(u, data));
        return { count: hit.length };
      },
    },
    gymLink: {
      async findFirst({ where, orderBy }) {
        let hit = state.gymLinks.filter((l) => matches(where, l));
        if (orderBy) {
          const [[field, dir]] = Object.entries(orderBy);
          hit = [...hit].sort((a, b) => ((a[field] ?? 0) < (b[field] ?? 0) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
        }
        return hit[0] ? { ...hit[0] } : null;
      },
      async findMany({ where }) {
        return state.gymLinks.filter((l) => matches(where, l)).map((l) => ({ ...l }));
      },
      async create({ data }) {
        const row = { id: nextLinkId++, removedAt: null, removedByPartnerId: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null, approvedAt: null, approvedByPartnerId: null, ...data };
        state.gymLinks.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = state.gymLinks.find((l) => l.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async updateMany({ where, data }) {
        const hit = state.gymLinks.filter((l) => matches(where, l));
        hit.forEach((l) => Object.assign(l, data));
        return { count: hit.length };
      },
      async count({ where }) {
        return state.gymLinks.filter((l) => matches(where, l)).length;
      },
    },
    userDevice: {
      async findMany({ where }) {
        let hit = state.userDevices.filter((d) => matches(where, d));
        if (where.distinct) {
          const seen = new Set();
          hit = hit.filter((d) => (seen.has(d[where.distinct[0]]) ? false : seen.add(d[where.distinct[0]])));
        }
        return hit.map((d) => ({ ...d }));
      },
    },
    appVersionSetting: {
      async findUnique({ where }) {
        if (!flagEnabled) return null;
        return { id: where.id, config: { features: { selfLinkGym: { enabled: true } } } };
      },
    },
    // Persona changes ride along with link/leave/removal (personaService).
    appModeHistory: {
      async findFirst({ where }) {
        const hit = state.appModeHistory.filter((h) => matches(where, h));
        return hit.length ? { ...hit[hit.length - 1] } : null;
      },
      async create({ data }) {
        state.appModeHistory.push({ ...data });
        return { ...data };
      },
      async count({ where }) {
        return state.appModeHistory.filter((h) => matches(where, h)).length;
      },
    },
  };
  api.$transaction = async (fn) => fn(api);
  return api;
}

let selfLink;
let leaveGymLink;
let removeGymMember;
let clearGymLinkNotice;
let gymLinkCheckedIn;
let unclaimedGymClaimed;
let listLinkRequests;
let approveLinkRequest;
let rejectLinkRequest;

test('setup: mock @prisma/client and authService once, import the controller once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class { constructor() { return createFakePrisma(); } }, Prisma: {} },
  });
  t.mock.module('../services/authService.js', {
    exports: {
      assertPartnerOwnsGym: (...args) => {
        if (partnerOwnsBehavior) return partnerOwnsBehavior(...args);
        return { id: args[0] };
      },
      // Used only for the best-effort "new member request" push; an empty gym
      // (no partnerId) skips the push, which is all these tests need.
      fetchGymInternal: async () => ({}),
    },
  });
  ({
    selfLink, leaveGymLink, removeGymMember, clearGymLinkNotice, gymLinkCheckedIn, unclaimedGymClaimed,
    listLinkRequests, approveLinkRequest, rejectLinkRequest,
  } = await import('../controllers/gymLinkController.js'));
});

function reset({ users = [], gymLinks = [], userDevices = [] } = {}) {
  state = { users, gymLinks, userDevices, appModeHistory: [] };
  flagEnabled = true;
  partnerOwnsBehavior = null;
}

const user = (over = {}) => ({ id: 7, linkedGymId: null, leaderboardOptIn: true, gymLinkNotice: null, ...over });
const req = (over = {}) => ({ headers: { 'x-user-id': '7' }, body: {}, params: {}, ...over });

// --- selfLink -----------------------------------------------------------------

test('selfLink is a 401 without a signed-in user', async () => {
  reset({ users: [user()] });
  const res = fakeRes();
  await selfLink(req({ headers: {} }), res);
  assert.equal(res.statusCode, 401);
});

test('selfLink is a 403 when the flag is off', async () => {
  reset({ users: [user()] });
  flagEnabled = false;
  const res = fakeRes();
  await selfLink(req({ body: { gymId: 3 } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'FLAG_DISABLED');
});

test('selfLink requires a valid gymId', async () => {
  reset({ users: [user()] });
  const res = fakeRes();
  await selfLink(req({ body: {} }), res);
  assert.equal(res.statusCode, 400);
});

test('selfLink returns the link shape on success', async () => {
  reset({ users: [user()] });
  const res = fakeRes();
  await selfLink(req({ body: { gymId: 3 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.link.gymId, 3);
  assert.equal(res.body.link.source, 'self');
  assert.equal(res.body.link.status, 'pending', 'a fresh self link waits for the gym');
});

test('selfLink is a 404 when the user does not exist', async () => {
  reset({ users: [] });
  const res = fakeRes();
  await selfLink(req({ body: { gymId: 3 } }), res);
  assert.equal(res.statusCode, 404);
});

test('selfLink surfaces the service error code for a blocked re-link', async () => {
  reset({
    users: [user()],
    gymLinks: [{ id: 1, userId: 7, gymId: 3, source: 'gym_qr', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: new Date(Date.now() - DAY), selfRelinkBlocked: true, firstVerifiedCheckinAt: null }],
  });
  const res = fakeRes();
  await selfLink(req({ body: { gymId: 3 } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'SELF_LINK_BLOCKED');
});

// --- leaveGymLink -------------------------------------------------------------

test('leaving is gated by the same flag', async () => {
  reset({ users: [user()] });
  flagEnabled = false;
  const res = fakeRes();
  await leaveGymLink(req(), res);
  assert.equal(res.statusCode, 403);
});

test('leaving clears the pointer and ends 204', async () => {
  reset({
    users: [user({ linkedGymId: 3 })],
    gymLinks: [{ id: 1, userId: 7, gymId: 3, source: 'gym_qr', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  const res = fakeRes();
  await leaveGymLink(req(), res);
  assert.equal(res.statusCode, 204);
  assert.equal(state.users[0].linkedGymId, null);
  assert.ok(state.gymLinks[0].removedAt);
});

// --- removeGymMember ----------------------------------------------------------

test('removal is a 403 for a non-partner', async () => {
  reset({ users: [user()] });
  const res = fakeRes();
  await removeGymMember(req({ user: { id: 7, role: 'customer' }, params: { gymId: '3', userId: '9' } }), res);
  assert.equal(res.statusCode, 403);
});

test('removal propagates a 404 from the ownership check', async () => {
  reset({ users: [user()] });
  partnerOwnsBehavior = () => { const e = new Error('Gym not found'); e.status = 404; throw e; };
  const res = fakeRes();
  await removeGymMember(req({ user: { id: 7, role: 'partner' }, params: { gymId: '3', userId: '9' } }), res);
  assert.equal(res.statusCode, 404);
});

test('removal propagates a 403 from the ownership check', async () => {
  reset({ users: [user()] });
  partnerOwnsBehavior = () => { const e = new Error('Forbidden'); e.status = 403; throw e; };
  const res = fakeRes();
  await removeGymMember(req({ user: { id: 7, role: 'partner' }, params: { gymId: '3', userId: '9' } }), res);
  assert.equal(res.statusCode, 403);
});

test('a partner removal closes the link, clears the pointer and leaves a notice', async () => {
  reset({
    users: [{ ...user(), id: 9, linkedGymId: 3 }, user({ id: 7 })],
    gymLinks: [{ id: 1, userId: 9, gymId: 3, source: 'gym_qr', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  const res = fakeRes();
  await removeGymMember(req({ user: { id: 7, role: 'partner' }, params: { gymId: '3', userId: '9' } }), res);
  assert.equal(res.statusCode, 204);
  assert.ok(state.gymLinks[0].removedAt);
  assert.equal(state.gymLinks[0].selfRelinkBlocked, true);
  assert.equal(state.users.find((u) => u.id === 9).linkedGymId, null);
  assert.equal(state.users.find((u) => u.id === 9).gymLinkNotice, 'removed_by_gym');
});

// --- clearGymLinkNotice -------------------------------------------------------

test('clearing the notice is a 401 without a user', async () => {
  reset({ users: [user()] });
  const res = fakeRes();
  await clearGymLinkNotice(req({ headers: {} }), res);
  assert.equal(res.statusCode, 401);
});

test('clearing the notice nulls it and ends 204', async () => {
  reset({ users: [user({ gymLinkNotice: 'removed_by_gym' })] });
  const res = fakeRes();
  await clearGymLinkNotice(req(), res);
  assert.equal(res.statusCode, 204);
  assert.equal(state.users[0].gymLinkNotice, null);
});

// --- internal hooks -----------------------------------------------------------

test('the internal checked-in hook requires both ids', async () => {
  reset({ users: [user()] });
  const res = fakeRes();
  await gymLinkCheckedIn({ body: { userId: 7 } }, res);
  assert.equal(res.statusCode, 400);
});

test('the internal checked-in hook stamps the active link', async () => {
  reset({
    users: [user({ linkedGymId: 3 })],
    gymLinks: [{ id: 1, userId: 7, gymId: 3, source: 'gym_qr', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  const res = fakeRes();
  await gymLinkCheckedIn({ body: { userId: 7, gymId: 3 } }, res);
  assert.equal(res.statusCode, 204);
  assert.ok(state.gymLinks[0].firstVerifiedCheckinAt);
});

test('the unclaimed-claim hook is a 400 without a claimedGymId', async () => {
  reset({ users: [user()] });
  const res = fakeRes();
  await unclaimedGymClaimed({ body: { unclaimedGymId: 400 } }, res);
  assert.equal(res.statusCode, 400);
});

test('the unclaimed-claim hook prompts the affected customers', async () => {
  reset({ users: [user({ id: 1, homeUnclaimedGymId: 400 }), user({ id: 2 })] });
  const res = fakeRes();
  await unclaimedGymClaimed({ body: { unclaimedGymId: 400, claimedGymId: 900, customerIds: [2] } }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(state.users.find((u) => u.id === 1).pendingGymPromptGymId, 900);
  assert.equal(state.users.find((u) => u.id === 2).pendingGymPromptGymId, 900);
});

// --- gym-side link requests (approve / reject) --------------------------------

const pendingSelf = (over = {}) => ({
  id: 1, userId: 9, gymId: 3, source: 'self', linkedAt: new Date(), removedAt: null,
  selfRelinkBlocked: false, firstVerifiedCheckinAt: null, approvedAt: null, approvedByPartnerId: null, ...over,
});
const partnerReq = (params) => req({ user: { id: 7, role: 'partner' }, params });

test('the link-request routes are partner-only', async () => {
  for (const handler of [listLinkRequests, approveLinkRequest, rejectLinkRequest]) {
    reset({ users: [user()] });
    const res = fakeRes();
    await handler(req({ user: { id: 7, role: 'customer' }, params: { gymId: '3', userId: '9' } }), res);
    assert.equal(res.statusCode, 403);
  }
});

test('the link-request routes check the partner owns the gym', async () => {
  for (const handler of [listLinkRequests, approveLinkRequest, rejectLinkRequest]) {
    reset({ users: [user()] });
    partnerOwnsBehavior = () => { throw { status: 403, error: 'Forbidden' }; };
    const res = fakeRes();
    await handler(partnerReq({ gymId: '3', userId: '9' }), res);
    assert.equal(res.statusCode, 403);
  }
});

test('the link-request routes reject a nonsense id', async () => {
  reset({ users: [user()] });
  const bad = fakeRes();
  await approveLinkRequest(partnerReq({ gymId: '3', userId: 'abc' }), bad);
  assert.equal(bad.statusCode, 400);
  const badGym = fakeRes();
  await listLinkRequests(partnerReq({ gymId: 'x' }), badGym);
  assert.equal(badGym.statusCode, 400);
});

test('listing returns the gym\'s pending claims as first name only, no phone', async () => {
  reset({
    users: [{ ...user(), id: 9, name: 'Asha Verma', phone: '+919999999999' }, user({ id: 7 })],
    gymLinks: [pendingSelf(), pendingSelf({ id: 2, userId: 8, approvedAt: new Date() })],
  });
  const res = fakeRes();
  await listLinkRequests(partnerReq({ gymId: '3' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].userId, 9);
  assert.equal(res.body.data[0].name, 'Asha');
  assert.ok(!('phone' in res.body.data[0]));
});

test('approving answers 204 and stamps the link', async () => {
  reset({ users: [{ ...user(), id: 9, linkedGymId: 3 }, user({ id: 7 })], gymLinks: [pendingSelf()] });
  const res = fakeRes();
  await approveLinkRequest(partnerReq({ gymId: '3', userId: '9' }), res);
  assert.equal(res.statusCode, 204);
  assert.ok(state.gymLinks[0].approvedAt);
  assert.equal(state.gymLinks[0].approvedByPartnerId, 7);
});

test('approving a claim that is gone is a 404 with a stable code', async () => {
  reset({ users: [user({ id: 7 })], gymLinks: [] });
  const res = fakeRes();
  await approveLinkRequest(partnerReq({ gymId: '3', userId: '9' }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'LINK_NOT_FOUND');
});

test('rejecting answers 204, closes the link and blocks self-rejoin', async () => {
  reset({ users: [{ ...user(), id: 9, linkedGymId: 3 }, user({ id: 7 })], gymLinks: [pendingSelf()] });
  const res = fakeRes();
  await rejectLinkRequest(partnerReq({ gymId: '3', userId: '9' }), res);
  assert.equal(res.statusCode, 204);
  assert.ok(state.gymLinks[0].removedAt);
  assert.equal(state.gymLinks[0].selfRelinkBlocked, true);
  assert.equal(state.users.find((u) => u.id === 9).linkedGymId, null);
});

test('rejecting an already-confirmed member is a 409 and changes nothing', async () => {
  reset({
    users: [{ ...user(), id: 9, linkedGymId: 3 }, user({ id: 7 })],
    gymLinks: [pendingSelf({ approvedAt: new Date() })],
  });
  const res = fakeRes();
  await rejectLinkRequest(partnerReq({ gymId: '3', userId: '9' }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'LINK_NOT_PENDING');
  assert.equal(state.gymLinks[0].removedAt, null);
});
