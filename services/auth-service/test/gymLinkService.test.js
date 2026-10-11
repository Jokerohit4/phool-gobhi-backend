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
  isSelfLinkGymEnabled,
  getActiveLink,
} from '../services/gymLinkService.js';

const DAY = 24 * 60 * 60 * 1000;

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

function createFakePrisma({ users = [], gymLinks = [], userDevices = [], appVersionSettings = [] } = {}) {
  const state = {
    users: users.map((u) => ({ ...u })),
    gymLinks: gymLinks.map((l) => ({ ...l })),
    userDevices: userDevices.map((d) => ({ ...d })),
    appVersionSettings: appVersionSettings.map((s) => ({ ...s })),
  };
  let nextLinkId = state.gymLinks.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1;

  const api = {
    user: {
      async findUnique({ where }) {
        const row = state.users.find((u) => u.id === where.id);
        return row ? { ...row } : null;
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
      async findMany({ where }) {
        return state.gymLinks.filter((l) => matches(where, l)).map((l) => ({ ...l }));
      },
      async create({ data }) {
        const row = { id: nextLinkId++, removedAt: null, removedByPartnerId: null, selfRelinkBlocked: false, firstVerifiedCheckinAt: null, ...data };
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
