// Gym-link service (coach-journey B2). The unit tests run the real service
// against an in-memory Prisma double, so every rule the billing/roster paths
// depend on is pinned at the level it is written: first-link-wins, the
// self-link guards, the verified-check-in qualification, and the
// unclaimed-gym prompt fan-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  linkGym,
  leaveGym,
  removeMemberFromGym,
  markGymCheckedIn,
  applyUnclaimedGymClaim,
  acceptClaimPrompt,
  dismissClaimPrompt,
  isSelfLinkGymEnabled,
  getActiveLink,
  isPendingSelfLink,
  listPendingSelfLinks,
  approveSelfLink,
  rejectSelfLink,
  joinGymViaQr,
  getJoinWindow,
  setJoinWindow,
} from '../services/gymLinkService.js';

const DAY = 24 * 60 * 60 * 1000;

// Links/leaves announce persona changes to other services (personaEvents.js).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// --- a small in-memory Prisma -------------------------------------------------
// Only the operators the service actually uses are interpreted: equality,
// `not`, `in`, `gte`, `lt`, plus top-level OR/AND. Enough to be honest about
// the queries without re-implementing Prisma.

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

function order(rows, orderBy) {
  if (!orderBy) return rows;
  const [[field, dir]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => {
    const av = a[field]?.getTime?.() ?? a[field];
    const bv = b[field]?.getTime?.() ?? b[field];
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
  });
}

function createFakePrisma({ users = [], gymLinks = [], userDevices = [], appVersionSettings = [], appModeHistory = [], gymJoinWindows = [] } = {}) {
  const state = {
    users: users.map((u) => ({ ...u })),
    gymLinks: gymLinks.map((l) => ({ ...l })),
    userDevices: userDevices.map((d) => ({ ...d })),
    appVersionSettings: appVersionSettings.map((s) => ({ ...s })),
    appModeHistory: appModeHistory.map((h) => ({ ...h })),
    gymJoinWindows: gymJoinWindows.map((w) => ({ ...w })),
  };
  let nextLinkId = state.gymLinks.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1;

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
        const hit = order(state.gymLinks.filter((l) => matches(where, l)), orderBy);
        return hit[0] ? { ...hit[0] } : null;
      },
      async findMany({ where, orderBy }) {
        return order(state.gymLinks.filter((l) => matches(where, l)), orderBy).map((l) => ({ ...l }));
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
        const row = state.appVersionSettings.find((s) => s.id === where.id);
        return row ? { ...row } : null;
      },
    },
    gymJoinWindow: {
      async findUnique({ where }) {
        const row = state.gymJoinWindows.find((w) => w.gymId === where.gymId);
        return row ? { ...row } : null;
      },
      async upsert({ where, create, update }) {
        const row = state.gymJoinWindows.find((w) => w.gymId === where.gymId);
        if (row) { Object.assign(row, update); return { ...row }; }
        state.gymJoinWindows.push({ ...create });
        return { ...create };
      },
      async deleteMany({ where }) {
        const before = state.gymJoinWindows.length;
        state.gymJoinWindows = state.gymJoinWindows.filter((w) => !matches(where, w));
        return { count: before - state.gymJoinWindows.length };
      },
    },
  };
  // Persona changes ride along with link/leave/removal (personaService).
  api.appModeHistory = {
    async findFirst({ where, orderBy }) {
      const hit = order(state.appModeHistory.filter((h) => matches(where, h)), orderBy);
      return hit[0] ? { ...hit[0] } : null;
    },
    async create({ data }) {
      const row = { id: state.appModeHistory.length + 1, createdAt: new Date(), ...data };
      state.appModeHistory.push(row);
      return { ...row };
    },
    async count({ where }) {
      return state.appModeHistory.filter((h) => matches(where, h)).length;
    },
  };
  // Interactive transactions run against the same state (the double is
  // single-connection, so a real rollback is not modelled — tests assert on the
  // committed shape, which is what succeeds in production too).
  api.$transaction = async (fn) => fn(api);
  return { prisma: api, state };
}

const baseUser = (over = {}) => ({ id: 1, linkedGymId: null, leaderboardOptIn: true, homeUnclaimedGymId: null, pendingGymPromptGymId: null, gymLinkNotice: null, ...over });

// --- isSelfLinkGymEnabled -----------------------------------------------------

test('the self-link flag falls back to the registry default when nothing is stored', async () => {
  const { prisma } = createFakePrisma();
  // selfLinkGym is registered defaultEnabled:false — a fresh environment is off.
  assert.equal(await isSelfLinkGymEnabled(prisma), false);
});

test('a stored app-config value wins over the registry default', async () => {
  const on = createFakePrisma({ appVersionSettings: [{ id: 1, config: { features: { selfLinkGym: { enabled: true } } } }] });
  assert.equal(await isSelfLinkGymEnabled(on.prisma), true);
  const off = createFakePrisma({ appVersionSettings: [{ id: 1, config: { features: { selfLinkGym: { enabled: false } } } }] });
  assert.equal(await isSelfLinkGymEnabled(off.prisma), false);
});

// --- linkGym: the QR path -----------------------------------------------------

test('a QR link points the user at the gym and records a gym_qr GymLink', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser()] });
  const result = await linkGym(prisma, 1, 7, 'gym_qr');
  assert.equal(result.linkedGymId, 7);
  assert.equal(state.gymLinks.length, 1);
  assert.equal(state.gymLinks[0].gymId, 7);
  assert.equal(state.gymLinks[0].source, 'gym_qr');
});

test('the QR path closes a prior active link before creating the new one', async () => {
  const { prisma, state } = createFakePrisma({
    // A left-then-rejoined user: the old link is already removed, a stale active
    // one should be closed rather than left dangling.
    users: [baseUser({ linkedGymId: null })],
    gymLinks: [{ id: 10, userId: 1, gymId: 3, source: 'self', linkedAt: new Date(Date.now() - DAY), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  await linkGym(prisma, 1, 7, 'gym_qr');
  assert.ok(state.gymLinks.find((l) => l.id === 10).removedAt, 'the prior active link is closed');
  assert.equal(state.gymLinks.filter((l) => l.removedAt === null).length, 1);
});

test('first link wins: a QR scan does not reassign an already-linked user', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser({ linkedGymId: 7 })] });
  const result = await linkGym(prisma, 1, 99, 'gym_qr');
  assert.equal(result.linkedGymId, 7);
  assert.equal(state.gymLinks.length, 0, 'no second link is written');
});

test('linking an unknown user returns null', async () => {
  const { prisma } = createFakePrisma();
  assert.equal(await linkGym(prisma, 404, 7, 'gym_qr'), null);
});

test('a nonsense gymId is ignored rather than written', async () => {
  for (const bad of [0, -1, 1.5, 'abc', null, undefined]) {
    const { prisma, state } = createFakePrisma({ users: [baseUser()] });
    assert.equal(await linkGym(prisma, 1, bad, 'gym_qr'), null, `gymId ${JSON.stringify(bad)}`);
    assert.equal(state.users[0].linkedGymId, null);
    assert.equal(state.gymLinks.length, 0);
  }
});

// --- linkGym: the self path ---------------------------------------------------

test('a self-link records a self GymLink and opts the user out of the leaderboard', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser({ leaderboardOptIn: true })] });
  const result = await linkGym(prisma, 1, 7, 'self');
  assert.equal(result.linkedGymId, 7);
  assert.equal(result.leaderboardOptIn, false);
  assert.equal(state.gymLinks[0].source, 'self');
});

test('a gym that removed the user blocks self-rejoin with SELF_LINK_BLOCKED', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser()],
    gymLinks: [{ id: 10, userId: 1, gymId: 7, source: 'gym_qr', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: new Date(Date.now() - DAY), selfRelinkBlocked: true, firstVerifiedCheckinAt: null }],
  });
  await assert.rejects(() => linkGym(prisma, 1, 7, 'self'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.errorCode, 'SELF_LINK_BLOCKED');
    return true;
  });
});

test('a second self-link inside the cooldown is SELF_LINK_LIMIT', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser()],
    gymLinks: [{ id: 10, userId: 1, gymId: 5, source: 'self', linkedAt: new Date(Date.now() - 2 * DAY), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  await assert.rejects(() => linkGym(prisma, 1, 7, 'self'), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.errorCode, 'SELF_LINK_LIMIT');
    return true;
  });
});

test('a self-link older than the cooldown is allowed', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser()],
    gymLinks: [{ id: 10, userId: 1, gymId: 5, source: 'self', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: new Date(Date.now() - 35 * DAY), selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  const result = await linkGym(prisma, 1, 7, 'self');
  assert.equal(result.linkedGymId, 7);
  assert.equal(state.gymLinks.filter((l) => l.source === 'self').length, 2);
});

test('three self-links from the same device block a fourth, whatever the account', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser({ id: 1 })],
    // The current user and three others have all used the same install id.
    userDevices: [
      { userId: 1, installId: 'dev-1' },
      { userId: 2, installId: 'dev-1' },
      { userId: 3, installId: 'dev-1' },
      { userId: 4, installId: 'dev-1' },
    ],
    gymLinks: [
      { id: 1, userId: 2, gymId: 5, source: 'self', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null },
      { id: 2, userId: 3, gymId: 6, source: 'self', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null },
      { id: 3, userId: 4, gymId: 6, source: 'self', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null },
    ],
  });
  await assert.rejects(() => linkGym(prisma, 1, 7, 'self'), (err) => {
    assert.equal(err.errorCode, 'SELF_LINK_LIMIT');
    return true;
  });
});

test('a device with only two self-links still allows the third', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser({ id: 1 })],
    userDevices: [
      { userId: 1, installId: 'dev-1' },
      { userId: 2, installId: 'dev-1' },
      { userId: 3, installId: 'dev-1' },
    ],
    gymLinks: [
      { id: 1, userId: 2, gymId: 5, source: 'self', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null },
      { id: 2, userId: 3, gymId: 6, source: 'self', linkedAt: new Date(Date.now() - 40 * DAY), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null },
    ],
  });
  const result = await linkGym(prisma, 1, 7, 'self');
  assert.equal(result.linkedGymId, 7);
});

// --- leaveGym / removeMemberFromGym ------------------------------------------

test('leaving a gym closes the link and clears the pointer, with no re-link block', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 7 })],
    gymLinks: [{ id: 1, userId: 1, gymId: 7, source: 'gym_qr', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  await leaveGym(prisma, 1);
  assert.equal(state.users[0].linkedGymId, null);
  assert.ok(state.gymLinks[0].removedAt);
  assert.equal(state.gymLinks[0].selfRelinkBlocked, false);
});

test('a partner removal blocks self-rejoin and drops a gymLinkNotice', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 7 })],
    gymLinks: [{ id: 1, userId: 1, gymId: 7, source: 'gym_qr', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  await removeMemberFromGym(prisma, 7, 1, 55);
  assert.ok(state.gymLinks[0].removedAt);
  assert.equal(state.gymLinks[0].selfRelinkBlocked, true);
  assert.equal(state.gymLinks[0].removedByPartnerId, 55);
  assert.equal(state.users[0].linkedGymId, null);
  assert.equal(state.users[0].gymLinkNotice, 'removed_by_gym');
});

test('a partner removal for a different gym does not clear the pointer', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 7 })],
    gymLinks: [{ id: 1, userId: 1, gymId: 7, source: 'gym_qr', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  await removeMemberFromGym(prisma, 999, 1, 55);
  assert.equal(state.users[0].linkedGymId, 7);
});

// --- markGymCheckedIn ---------------------------------------------------------

test('a verified check-in stamps the active link once, and only once', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 7 })],
    gymLinks: [{ id: 1, userId: 1, gymId: 7, source: 'self', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  await markGymCheckedIn(prisma, 1, 7);
  const first = state.gymLinks[0].firstVerifiedCheckinAt;
  assert.ok(first);
  await markGymCheckedIn(prisma, 1, 7);
  assert.equal(state.gymLinks[0].firstVerifiedCheckinAt, first, 'the second call is a no-op');
});

test('a check-in with no active link is a no-op', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser()] });
  await markGymCheckedIn(prisma, 1, 7);
  assert.equal(state.gymLinks.length, 0);
});

test('a check-in at a removed link is a no-op', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: null })],
    gymLinks: [{ id: 1, userId: 1, gymId: 7, source: 'self', linkedAt: new Date(), removedAt: new Date(), selfRelinkBlocked: false, firstVerifiedCheckinAt: null }],
  });
  await markGymCheckedIn(prisma, 1, 7);
  assert.equal(state.gymLinks[0].firstVerifiedCheckinAt, null);
});

// --- applyUnclaimedGymClaim ---------------------------------------------------

test('claiming an unclaimed gym prompts both listed customers and its home users', async () => {
  const { prisma, state } = createFakePrisma({
    users: [
      baseUser({ id: 1, homeUnclaimedGymId: 400 }),
      baseUser({ id: 2 }),
      baseUser({ id: 3 }),
    ],
  });
  await applyUnclaimedGymClaim(prisma, { unclaimedGymId: 400, claimedGymId: 900, customerIds: [2] });
  assert.equal(state.users.find((u) => u.id === 1).pendingGymPromptGymId, 900);
  assert.equal(state.users.find((u) => u.id === 2).pendingGymPromptGymId, 900);
  assert.equal(state.users.find((u) => u.id === 3).pendingGymPromptGymId, null);
});

test('claiming without a claimedGymId is a 400', async () => {
  const { prisma } = createFakePrisma();
  await assert.rejects(() => applyUnclaimedGymClaim(prisma, { unclaimedGymId: 400 }), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

// --- getActiveLink ------------------------------------------------------------

test('getActiveLink returns the live link and null once removed', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser()],
    gymLinks: [
      { id: 1, userId: 1, gymId: 3, source: 'self', linkedAt: new Date(Date.now() - DAY), removedAt: new Date(), selfRelinkBlocked: false, firstVerifiedCheckinAt: null },
      { id: 2, userId: 1, gymId: 7, source: 'gym_qr', linkedAt: new Date(), removedAt: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null },
    ],
  });
  const active = await getActiveLink(prisma, 1);
  assert.equal(active.gymId, 7);
});

// --- claim prompt accept / dismiss --------------------------------------------

test('a claim prompt skips users already linked to another gym', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ id: 1, homeUnclaimedGymId: 400 }), baseUser({ id: 2, homeUnclaimedGymId: 400, linkedGymId: 55 })],
  });
  await applyUnclaimedGymClaim(prisma, { unclaimedGymId: 400, claimedGymId: 900, customerIds: [] });
  assert.equal(state.users[0].pendingGymPromptGymId, 900);
  assert.equal(state.users[1].pendingGymPromptGymId, null);
});

test('accepting the claim prompt links the user to the prompted gym and clears it', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser({ id: 1, pendingGymPromptGymId: 900 })] });
  await acceptClaimPrompt(prisma, 1);
  assert.equal(state.users[0].linkedGymId, 900);
  assert.equal(state.users[0].pendingGymPromptGymId, null);
  assert.equal(state.users[0].persona, 'linked_gym');
});

test('accepting with nothing pending, or while linked elsewhere, is refused', async () => {
  const none = createFakePrisma({ users: [baseUser({ id: 1 })] });
  await assert.rejects(acceptClaimPrompt(none.prisma, 1), { errorCode: 'NO_PENDING_PROMPT' });
  const other = createFakePrisma({ users: [baseUser({ id: 1, pendingGymPromptGymId: 900, linkedGymId: 55 })] });
  await assert.rejects(acceptClaimPrompt(other.prisma, 1), { errorCode: 'ALREADY_LINKED' });
});

test('dismissing the claim prompt clears it', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser({ id: 1, pendingGymPromptGymId: 900 })] });
  await dismissClaimPrompt(prisma, 1);
  assert.equal(state.users[0].pendingGymPromptGymId, null);
});

// --- gym-side approval of self links ------------------------------------------

const selfLink = (over = {}) => ({
  id: 1, userId: 1, gymId: 7, source: 'self', linkedAt: new Date(Date.now() - DAY),
  removedAt: null, removedByPartnerId: null, selfRelinkBlocked: false,
  firstVerifiedCheckinAt: null, approvedAt: null, approvedByPartnerId: null, ...over,
});

test('only an active, unconfirmed self link is pending', () => {
  assert.equal(isPendingSelfLink(selfLink()), true);
  assert.equal(isPendingSelfLink(selfLink({ approvedAt: new Date() })), false, 'approved');
  assert.equal(isPendingSelfLink(selfLink({ firstVerifiedCheckinAt: new Date() })), true, 'a visit is not membership approval');
  assert.equal(isPendingSelfLink(selfLink({ removedAt: new Date() })), false, 'already ended');
  assert.equal(isPendingSelfLink(selfLink({ source: 'gym_qr' })), false, 'the gym initiated a QR link');
});

test('a fresh self link is created pending, with no approval stamp', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser()] });
  await linkGym(prisma, 1, 7, 'self');
  assert.equal(state.gymLinks[0].approvedAt, null);
  assert.equal(isPendingSelfLink(state.gymLinks[0]), true);
});

test('the queue lists this gym\'s pending claims oldest first, first name only', async () => {
  const { prisma } = createFakePrisma({
    users: [
      baseUser({ id: 1, name: 'Asha Verma' }),
      baseUser({ id: 2, name: 'Ravi Kumar' }),
      baseUser({ id: 3, name: 'Elsewhere Person' }),
      baseUser({ id: 4, name: 'Confirmed Member' }),
      baseUser({ id: 5, name: 'Qr Member' }),
    ],
    gymLinks: [
      selfLink({ id: 1, userId: 2, linkedAt: new Date(Date.now() - 1 * DAY) }),
      selfLink({ id: 2, userId: 1, linkedAt: new Date(Date.now() - 3 * DAY) }),
      selfLink({ id: 3, userId: 3, gymId: 99 }),
      selfLink({ id: 4, userId: 4, approvedAt: new Date() }),
      selfLink({ id: 5, userId: 5, source: 'gym_qr' }),
    ],
  });
  const queue = await listPendingSelfLinks(prisma, 7);
  assert.deepEqual(queue.map((q) => [q.userId, q.name]), [[1, 'Asha'], [2, 'Ravi']]);
  assert.ok(queue.every((q) => !('phone' in q)), 'no phone number leaves the service');
});

test('an empty queue is an empty list', async () => {
  const { prisma } = createFakePrisma();
  assert.deepEqual(await listPendingSelfLinks(prisma, 7), []);
});

test('approving stamps who and when, and takes the claim out of the queue', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ id: 1, name: 'Asha', linkedGymId: 7 })],
    gymLinks: [selfLink()],
  });
  await approveSelfLink(prisma, 7, 1, 55);
  assert.ok(state.gymLinks[0].approvedAt instanceof Date);
  assert.equal(state.gymLinks[0].approvedByPartnerId, 55);
  assert.deepEqual(await listPendingSelfLinks(prisma, 7), []);
  assert.equal(state.users[0].linkedGymId, 7, 'approval never moves the user');
});

test('approving twice keeps the first stamp', async () => {
  const first = new Date(Date.now() - DAY);
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 7 })],
    gymLinks: [selfLink({ approvedAt: first, approvedByPartnerId: 55 })],
  });
  await approveSelfLink(prisma, 7, 1, 66);
  assert.equal(state.gymLinks[0].approvedAt, first);
  assert.equal(state.gymLinks[0].approvedByPartnerId, 55);
});

test('approving a QR link changes nothing', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 7 })],
    gymLinks: [selfLink({ source: 'gym_qr' })],
  });
  await approveSelfLink(prisma, 7, 1, 55);
  assert.equal(state.gymLinks[0].approvedAt, null);
});

test('approving a member who has already left is a 404 the partner UI can drop', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser()],
    gymLinks: [selfLink({ removedAt: new Date() })],
  });
  await assert.rejects(approveSelfLink(prisma, 7, 1, 55), { status: 404, errorCode: 'LINK_NOT_FOUND' });
});

test('approval is scoped to the gym: another gym\'s claim is not found', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser({ linkedGymId: 99 })],
    gymLinks: [selfLink({ gymId: 99 })],
  });
  await assert.rejects(approveSelfLink(prisma, 7, 1, 55), { errorCode: 'LINK_NOT_FOUND' });
});

test('rejecting a pending claim ends the link, blocks self-rejoin and leaves the removed notice', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ id: 1, linkedGymId: 7 })],
    gymLinks: [selfLink()],
  });
  await rejectSelfLink(prisma, 7, 1, 55);
  assert.ok(state.gymLinks[0].removedAt);
  assert.equal(state.gymLinks[0].removedByPartnerId, 55);
  assert.equal(state.gymLinks[0].selfRelinkBlocked, true);
  assert.equal(state.users[0].linkedGymId, null);
  assert.equal(state.users[0].gymLinkNotice, 'removed_by_gym');
  // ...and the same user cannot just self-link again.
  await assert.rejects(linkGym(prisma, 1, 7, 'self'), { errorCode: 'SELF_LINK_BLOCKED' });
});

test('reject cannot evict a confirmed member', async () => {
  for (const over of [{ approvedAt: new Date() }, { source: 'gym_qr' }]) {
    const { prisma, state } = createFakePrisma({
      users: [baseUser({ linkedGymId: 7 })],
      gymLinks: [selfLink(over)],
    });
    await assert.rejects(rejectSelfLink(prisma, 7, 1, 55), { status: 409, errorCode: 'LINK_NOT_PENDING' }, JSON.stringify(over));
    assert.equal(state.gymLinks[0].removedAt, null);
    assert.equal(state.users[0].linkedGymId, 7);
  }
});

test('rejecting with no active link is a 404', async () => {
  const { prisma } = createFakePrisma({ users: [baseUser()] });
  await assert.rejects(rejectSelfLink(prisma, 7, 1, 55), { status: 404, errorCode: 'LINK_NOT_FOUND' });
});

// --- joining from the entrance poster (presence already proven) ---------------

const HOUR = 60 * 60 * 1000;
const openWindow = (over = {}) => ({ gymId: 7, autoApproveUntil: new Date(Date.now() + HOUR), openedByPartnerId: 55, ...over });

test('with no window, a poster join leaves a pending request and flags it for the owner', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser()] });
  assert.deepEqual(await joinGymViaQr(prisma, 1, 7), { gymId: 7, status: 'pending', joined: true, requested: true });
  assert.equal(state.gymLinks[0].source, 'self');
  assert.equal(isPendingSelfLink(state.gymLinks[0]), true, 'billing and attendance wait for the gym');
});

test('with the owner window open, a poster join is approved on the spot', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser()], gymJoinWindows: [openWindow()] });
  assert.deepEqual(await joinGymViaQr(prisma, 1, 7), { gymId: 7, status: 'approved', joined: true, requested: false });
  assert.equal(state.gymLinks[0].source, 'self', 'an ordinary self link, so billing treats it like an owner-approved one');
  assert.equal(isPendingSelfLink(state.gymLinks[0]), false);
  assert.ok(state.gymLinks[0].approvedAt);
  assert.equal(state.gymLinks[0].approvedByPartnerId, null);
});

test('an expired window behaves like no window', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser()], gymJoinWindows: [openWindow({ autoApproveUntil: new Date(Date.now() - 1000) })],
  });
  assert.equal((await joinGymViaQr(prisma, 1, 7)).status, 'pending');
  assert.equal(isPendingSelfLink(state.gymLinks[0]), true);
});

test("one gym's window never approves a join at another gym", async () => {
  const { prisma } = createFakePrisma({ users: [baseUser()], gymJoinWindows: [openWindow({ gymId: 8 })] });
  assert.equal((await joinGymViaQr(prisma, 1, 7)).status, 'pending');
});

test('joining the gym you already belong to is a no-op that reports joined=false', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser({ linkedGymId: 7 })], gymLinks: [selfLink({ approvedAt: new Date() })] });
  assert.deepEqual(await joinGymViaQr(prisma, 1, 7), { gymId: 7, status: 'approved', joined: false, requested: false });
  assert.equal(state.gymLinks.length, 1);
});

test('a repeat scan while still pending neither re-notifies nor approves', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser({ linkedGymId: 7 })], gymLinks: [selfLink()] });
  assert.deepEqual(await joinGymViaQr(prisma, 1, 7), { gymId: 7, status: 'pending', joined: false, requested: false });
  assert.equal(isPendingSelfLink(state.gymLinks[0]), true);
});

test('an open window approves a request that was already waiting', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 7 })], gymLinks: [selfLink()], gymJoinWindows: [openWindow()],
  });
  assert.deepEqual(await joinGymViaQr(prisma, 1, 7), { gymId: 7, status: 'approved', joined: false, requested: false });
  assert.equal(isPendingSelfLink(state.gymLinks[0]), false);
});

test('a poster join never moves a member of another gym, window or not', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ linkedGymId: 3 })], gymLinks: [selfLink({ gymId: 3, source: 'gym_qr' })], gymJoinWindows: [openWindow()],
  });
  await assert.rejects(joinGymViaQr(prisma, 1, 7), { status: 409, errorCode: 'ALREADY_LINKED' });
  assert.equal(state.users[0].linkedGymId, 3);
});

test('a scan cannot undo a gym removing the member, even inside an open window', async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser()], gymJoinWindows: [openWindow()],
    gymLinks: [selfLink({ source: 'gym_qr', removedAt: new Date(), selfRelinkBlocked: true })],
  });
  await assert.rejects(joinGymViaQr(prisma, 1, 7), { status: 403, errorCode: 'MEMBERSHIP_BLOCKED' });
  assert.equal(state.users[0].linkedGymId, null);
  assert.equal(state.gymLinks.filter((l) => !l.removedAt).length, 0);
});

test('someone who left voluntarily can ask to rejoin by scanning', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser()],
    gymLinks: [selfLink({ source: 'gym_qr', removedAt: new Date(Date.now() - 40 * DAY), linkedAt: new Date(Date.now() - 60 * DAY), selfRelinkBlocked: false })],
  });
  assert.equal((await joinGymViaQr(prisma, 1, 7)).joined, true);
});

test('the monthly self-link limit still applies to poster joins', async () => {
  const { prisma } = createFakePrisma({
    users: [baseUser()], gymJoinWindows: [openWindow()],
    gymLinks: [selfLink({ gymId: 3, removedAt: new Date(), linkedAt: new Date(Date.now() - 2 * DAY) })],
  });
  await assert.rejects(joinGymViaQr(prisma, 1, 7), { errorCode: 'SELF_LINK_LIMIT' });
});

test('a poster join validates its input', async () => {
  const { prisma } = createFakePrisma({ users: [baseUser()] });
  await assert.rejects(joinGymViaQr(prisma, 1, 'nope'), { status: 400 });
  await assert.rejects(joinGymViaQr(prisma, 99, 7), { status: 404 });
});

// --- the owner's approve-every-join window ------------------------------------

test('a gym with no window reports it closed', async () => {
  const { prisma } = createFakePrisma();
  assert.deepEqual(await getJoinWindow(prisma, 7), { active: false, autoApproveUntil: null });
});

test('opening a window for 1, 8 or 24 hours ends that long from now', async () => {
  for (const hours of [1, 8, 24]) {
    const { prisma } = createFakePrisma();
    const before = Date.now();
    const result = await setJoinWindow(prisma, 7, 55, hours);
    assert.equal(result.active, true);
    const ms = result.autoApproveUntil.getTime() - before;
    assert.ok(Math.abs(ms - hours * HOUR) < 5000, `${hours}h window`);
    assert.equal((await getJoinWindow(prisma, 7)).active, true);
  }
});

test("opening a window approves everyone already waiting, and only this gym's queue", async () => {
  const { prisma, state } = createFakePrisma({
    users: [baseUser({ id: 1, linkedGymId: 7 }), baseUser({ id: 2, linkedGymId: 7 }), baseUser({ id: 3, linkedGymId: 8 })],
    gymLinks: [
      selfLink({ id: 1, userId: 1 }),
      selfLink({ id: 2, userId: 2 }),
      selfLink({ id: 3, userId: 3, gymId: 8 }),
    ],
  });
  const result = await setJoinWindow(prisma, 7, 55, 8);
  assert.deepEqual(result.approvedUserIds.sort(), [1, 2]);
  assert.equal(isPendingSelfLink(state.gymLinks[0]), false);
  assert.equal(isPendingSelfLink(state.gymLinks[1]), false);
  assert.equal(state.gymLinks[0].approvedByPartnerId, 55);
  assert.equal(isPendingSelfLink(state.gymLinks[2]), true, 'another gym is untouched');
});

test('re-opening replaces the previous window, and closing ends it at once', async () => {
  const { prisma, state } = createFakePrisma({ gymJoinWindows: [openWindow()] });
  await setJoinWindow(prisma, 7, 55, 24);
  assert.equal(state.gymJoinWindows.length, 1);
  const closed = await setJoinWindow(prisma, 7, 55, 0);
  assert.deepEqual(closed, { active: false, autoApproveUntil: null, approvedUserIds: [] });
  assert.equal((await getJoinWindow(prisma, 7)).active, false);
});

test('closing a window does not un-approve anyone who joined during it', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser()], gymJoinWindows: [openWindow()] });
  await joinGymViaQr(prisma, 1, 7);
  await setJoinWindow(prisma, 7, 55, 0);
  assert.equal(isPendingSelfLink(state.gymLinks[0]), false);
});

test('only 0, 1, 8 and 24 hours are accepted', async () => {
  const { prisma } = createFakePrisma();
  for (const hours of [2, -1, 100, NaN, 0.5]) {
    await assert.rejects(setJoinWindow(prisma, 7, 55, hours), { status: 400, errorCode: 'INVALID_WINDOW' });
  }
});

test('entrance QR request is pending and only gym approval can allow attendance', async () => {
  const { prisma, state } = createFakePrisma({ users: [baseUser()] });
  await linkGym(prisma, 1, 7, 'qr_request');
  assert.equal(state.gymLinks[0].source, 'self');
  assert.equal(isPendingSelfLink(state.gymLinks[0]), true);
  await markGymCheckedIn(prisma, 1, 7);
  assert.equal(isPendingSelfLink(state.gymLinks[0]), true);
  assert.equal((await listPendingSelfLinks(prisma, 7)).length, 1);
  await approveSelfLink(prisma, 7, 1, 99);
  assert.equal(isPendingSelfLink(state.gymLinks[0]), false);
});
