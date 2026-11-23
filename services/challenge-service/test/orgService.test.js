// Corporate-wellness behaviour against an in-memory database: who can be added,
// who can see what, and what happens when a company profile or a leaderboard
// expires. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- A tiny in-memory Prisma -------------------------------------------------
const db = { organization: [], organizationTeam: [], organizationMember: [], orgLeaderboard: [], attendanceEventLog: [] };
let seq = 1;

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((c) => matches(row, c));
    const v = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(v);
      if ('not' in cond) return cond.not === null ? v !== null && v !== undefined : v !== cond.not;
      if ('lte' in cond) return v != null && v <= cond.lte;
      if ('lt' in cond) return v != null && v < cond.lt;
      if ('gte' in cond) return v != null && v >= cond.gte;
      if ('gt' in cond) return v != null && v > cond.gt;
    }
    return v === cond;
  });
}
// Minimal `include` support for the relations the services actually use.
function attach(name, row, include) {
  if (!row || !include) return row;
  const out = { ...row };
  const nested = (v) => (v && typeof v === 'object' ? v.include : undefined);
  if (include.org) out.org = attach('organization', db.organization.find((o) => o.id === row.orgId), nested(include.org));
  if (include.team) out.team = db.organizationTeam.find((t) => t.id === row.teamId) ?? null;
  if (include.leaderboards) {
    const w = include.leaderboards.where ?? {};
    out.leaderboards = db.orgLeaderboard.filter((b) => b.orgId === row.id && matches(b, w));
  }
  return out;
}

function model(name, { defaults = () => ({}), unique = [] } = {}) {
  const rows = () => db[name];
  const byCompound = (where) => {
    const [[, compound]] = Object.entries(where);
    return rows().find((r) => Object.entries(compound).every(([k, v]) => r[k] === v));
  };
  return {
    findUnique: async ({ where }) => {
      const k = Object.keys(where)[0];
      return (k.includes('_') ? byCompound(where) : rows().find((r) => r[k] === where[k])) ?? null;
    },
    findFirst: async ({ where, include }) => attach(name, rows().find((r) => matches(r, where)), include) ?? null,
    findMany: async ({ where, include } = {}) => rows().filter((r) => matches(r, where)).map((r) => attach(name, r, include)),
    create: async ({ data }) => {
      for (const fields of unique) {
        if (rows().some((r) => fields.every((f) => r[f] === data[f]))) throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row = { id: seq++, createdAt: new Date(), ...defaults(), ...data };
      rows().push(row);
      return row;
    },
    update: async ({ where, data }) => { const r = rows().find((x) => x.id === where.id); Object.assign(r, data); return r; },
    updateMany: async ({ where, data }) => { const hit = rows().filter((r) => matches(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
    upsert: async ({ where, create }) => {
      const found = byCompound(where);
      if (found) return found;
      const row = { id: seq++, createdAt: new Date(), ...create }; rows().push(row); return row;
    },
    delete: async ({ where }) => { const i = rows().findIndex((r) => r.id === where.id); rows().splice(i, 1); return {}; },
  };
}

// ---- Directory fake: which phones have accounts ------------------------------
const accounts = new Map(); // phone -> { id, name, leaderboardOptIn }
let directoryDown = false;
let activity = { data: {}, complete: true };

let svc; let boards; let real;

test('setup', async (t) => {
  real = await import('../services/orgDirectory.js?real');
  t.mock.module('../db/prisma.js', {
    defaultExport: {
      organization: model('organization', { defaults: () => ({ status: 'active', convertedAt: null, startsAt: new Date('2026-01-01T00:00:00Z') }), unique: [['slug']] }),
      organizationTeam: model('organizationTeam', { unique: [['orgId', 'name']] }),
      organizationMember: model('organizationMember', { defaults: () => ({ userId: null, teamId: null, status: 'invited', addedAt: new Date() }) }),
      orgLeaderboard: model('orgLeaderboard', { defaults: () => ({ status: 'active', scoring: 'active_days', showTeams: true, endsAt: null }) }),
      attendanceEventLog: model('attendanceEventLog'),
    },
  });
  t.mock.module('../services/orgDirectory.js', {
    namedExports: {
      normalizePhone: real.normalizePhone,
      lookupUserIdByPhone: async (phone) => {
        if (directoryDown) throw { status: 503, error: 'down' };
        return accounts.get(phone)?.id ?? null;
      },
      fetchUsersByIds: async (ids) => Object.fromEntries(
        [...accounts.entries()].filter(([, u]) => ids.includes(u.id)).map(([phone, u]) => [u.id, { ...u, phone }])),
      fetchOrgActivity: async () => activity,
    },
  });
  svc = await import('../services/orgService.js');
  boards = await import('../services/orgLeaderboardService.js');
});

function reset() {
  for (const k of Object.keys(db)) db[k] = [];
  accounts.clear(); directoryDown = false; activity = { data: {}, complete: true };
  boards.clearOrgBoardCache();
}
const PHONE = { a: '9876543210', b: '9876543211', c: '9876543212' };
const user = (phone, id, name, over = {}) => accounts.set(phone, { id, name, leaderboardOptIn: true, ...over });

// ---- Creating and expiring a company ----------------------------------------

test('a company needs a name and an expiry later than its start', async () => {
  reset();
  await assert.rejects(svc.createOrg({ name: 'x' }, 1), (e) => e.status === 400);
  await assert.rejects(
    svc.createOrg({ name: 'Acme', startsAt: '2026-06-01', expiresAt: '2026-05-01' }, 1),
    (e) => e.status === 400 && /after/.test(e.error));
  const ok = await svc.createOrg({ name: 'Acme Corp' }, 1);
  assert.equal(ok.slug, 'acme-corp');
  assert.equal(ok.unlimited, true); // no expiry = never converts
  const second = await svc.createOrg({ name: 'Acme Corp' }, 1);
  assert.equal(second.slug, 'acme-corp-2');
});

test('an expired company disappears from the app, its members stay normal users, and extending brings it back', async () => {
  reset();
  user(PHONE.a, 11, 'Asha Rao');
  const org = await svc.createOrg({ name: 'Acme', startsAt: '2026-01-01', expiresAt: '2099-01-01' }, 1);
  await svc.addMembers(org.id, [{ phone: PHONE.a }], 1);
  assert.equal((await svc.getMyOrganizations(11)).length, 1);

  // The profile lapses (date moves into the past without any sweep running).
  db.organization[0].expiresAt = new Date('2026-02-01T00:00:00Z');
  assert.deepEqual(await svc.getMyOrganizations(11), [], 'lapsed profile must stop showing immediately');
  // The sweep persists the state for staff views; the member row is untouched.
  assert.equal(db.organization[0].status, 'expired');
  assert.ok(db.organization[0].convertedAt instanceof Date);
  assert.equal(db.organizationMember[0].status, 'active');

  // Staff extend it: back on, conversion cleared.
  await svc.updateOrg(org.id, { expiresAt: '2099-06-01' });
  assert.equal(db.organization[0].status, 'active');
  assert.equal(db.organization[0].convertedAt, null);
  assert.equal((await svc.getMyOrganizations(11)).length, 1);
});

test('removing the expiry makes a company permanent; archiving hides it', async () => {
  reset();
  user(PHONE.a, 11, 'Asha Rao');
  const org = await svc.createOrg({ name: 'Acme', expiresAt: '2099-01-01' }, 1);
  await svc.addMembers(org.id, [{ phone: PHONE.a }], 1);
  const out = await svc.updateOrg(org.id, { expiresAt: null });
  assert.equal(out.unlimited, true);
  await svc.updateOrg(org.id, { status: 'archived' });
  assert.deepEqual(await svc.getMyOrganizations(11), []);
});

// ---- Membership is controlled from the backend ------------------------------

test('adding by phone: existing accounts join at once, unknown phones are invited, junk is reported', async () => {
  reset();
  user(PHONE.a, 11, 'Asha Rao');
  const org = await svc.createOrg({ name: 'Acme' }, 1);
  const out = await svc.addMembers(org.id, [
    { phone: '+91 98765 43210', team: 'Sales' },
    { phone: PHONE.b, name: 'Bala' },
    { phone: '12345' },
    { phone: PHONE.a }, // duplicate of the first row in the same request
  ], 1);
  assert.equal(out.added, 2);
  assert.equal(out.linked, 1);
  assert.equal(out.invited, 1);
  assert.deepEqual(out.invalid.map((r) => r.reason), ['invalid_phone', 'duplicate_in_request']);
  const asha = db.organizationMember.find((m) => m.phone === PHONE.a);
  assert.equal(asha.status, 'active');
  assert.equal(asha.userId, 11);
  assert.equal(db.organizationMember.find((m) => m.phone === PHONE.b).status, 'invited');
  assert.equal(db.organizationTeam.length, 1);
});

test('an invited phone is linked the first time that person opens the app', async () => {
  reset();
  const org = await svc.createOrg({ name: 'Acme' }, 1);
  await svc.addMembers(org.id, [{ phone: PHONE.b }], 1);
  assert.equal(db.organizationMember[0].status, 'invited');
  user(PHONE.b, 22, 'Bala K'); // they sign up later
  const mine = await svc.getMyOrganizations(22);
  assert.equal(mine.length, 1);
  assert.equal(db.organizationMember[0].status, 'active');
  assert.equal(db.organizationMember[0].userId, 22);
});

test('someone who was never added sees nothing', async () => {
  reset();
  user(PHONE.c, 33, 'Outsider');
  await svc.createOrg({ name: 'Acme' }, 1);
  assert.deepEqual(await svc.getMyOrganizations(33), []);
});

test('re-adding someone who was removed reactivates them; re-adding a member is a no-op', async () => {
  reset();
  user(PHONE.a, 11, 'Asha Rao');
  const org = await svc.createOrg({ name: 'Acme' }, 1);
  await svc.addMembers(org.id, [{ phone: PHONE.a }], 1);
  const again = await svc.addMembers(org.id, [{ phone: PHONE.a }], 1);
  assert.equal(again.alreadyMember, 1);
  await svc.removeMember(org.id, db.organizationMember[0].id);
  assert.deepEqual(await svc.getMyOrganizations(11), []);
  const back = await svc.addMembers(org.id, [{ phone: PHONE.a }], 1);
  assert.equal(back.reactivated, 1);
  assert.equal((await svc.getMyOrganizations(11)).length, 1);
});

test('if the accounts service is down, nobody is silently recorded as "invited"', async () => {
  reset();
  const org = await svc.createOrg({ name: 'Acme' }, 1);
  directoryDown = true;
  await assert.rejects(svc.addMembers(org.id, [{ phone: PHONE.a }], 1), (e) => e.status === 503);
  assert.equal(db.organizationMember.length, 0);
});

test('members cannot be added to an expired company, and the batch size is capped', async () => {
  reset();
  const org = await svc.createOrg({ name: 'Acme', startsAt: '2026-01-01', expiresAt: '2099-01-01' }, 1);
  db.organization[0].expiresAt = new Date('2026-02-01T00:00:00Z');
  await assert.rejects(svc.addMembers(org.id, [{ phone: PHONE.a }], 1), (e) => e.status === 409);
  db.organization[0].expiresAt = null;
  await assert.rejects(svc.addMembers(org.id, Array.from({ length: 501 }, () => ({ phone: PHONE.a })), 1), (e) => e.status === 400);
});

// ---- Leaderboards -----------------------------------------------------------

async function seedBoard({ boardOver = {}, orgOver = {} } = {}) {
  user(PHONE.a, 11, 'Asha Rao'); user(PHONE.b, 22, 'Bala Kumar'); user(PHONE.c, 33, 'Chitra Menon', { leaderboardOptIn: false });
  const org = await svc.createOrg({ name: 'Acme', ...orgOver }, 1);
  await svc.addMembers(org.id, [{ phone: PHONE.a, team: 'Sales' }, { phone: PHONE.b, team: 'Ops' }, { phone: PHONE.c, team: 'Ops' }], 1);
  const board = await svc.createLeaderboard(org.id, { name: 'December challenge', startsAt: '2026-12-01', ...boardOver }, 1);
  return { org, board };
}
const NOW = new Date('2026-12-10T08:00:00Z');

test('a leaderboard can be unlimited, or have an end date, and the end must follow the start', async () => {
  reset();
  const { org, board } = await seedBoard();
  assert.equal(board.unlimited, true);
  assert.equal(board.endsAt, null);
  const limited = await svc.updateLeaderboard(org.id, board.id, { endsAt: '2026-12-31T00:00:00Z' });
  assert.equal(limited.unlimited, false);
  const unlimitedAgain = await svc.updateLeaderboard(org.id, board.id, { endsAt: null });
  assert.equal(unlimitedAgain.unlimited, true);
  await assert.rejects(svc.updateLeaderboard(org.id, board.id, { endsAt: '2026-11-01' }), (e) => e.status === 400);
});

test('standings rank only members, respect opt-out, and show colleagues by short name', async () => {
  reset();
  const { org, board } = await seedBoard();
  activity = { complete: true, data: {
    11: { workoutDays: ['2026-12-02', '2026-12-03', '2026-12-04'], stepsByDay: {} },
    22: { workoutDays: ['2026-12-02'], stepsByDay: { '2026-12-05': 8000 } },
    33: { workoutDays: ['2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05'], stepsByDay: {} },
  } };
  const out = await boards.getBoardStandings(org.id, board.id, 22, NOW);
  assert.deepEqual(out.entries.map((e) => [e.rank, e.name, e.score, e.isMe]), [[1, 'Asha R.', 3, false], [2, 'Bala Kumar', 2, true]]);
  assert.equal(out.totalRanked, 2, 'the opted-out member is neither ranked nor shown');
  assert.equal(out.me.rank, 2);
  assert.deepEqual(out.teams.map((t) => [t.name, t.score]), [['Sales', 3], ['Ops', 2]]);
  assert.equal(out.complete, true);
});

test("people outside the company get a 404, not a hint that it exists", async () => {
  reset();
  const { org, board } = await seedBoard();
  user('9000000001', 99, 'Outsider');
  await assert.rejects(boards.getBoardStandings(org.id, board.id, 99, NOW), (e) => e.status === 404);
});

test('a removed member loses access immediately', async () => {
  reset();
  const { org, board } = await seedBoard();
  await svc.removeMember(org.id, db.organizationMember.find((m) => m.userId === 11).id);
  await assert.rejects(boards.getBoardStandings(org.id, board.id, 11, NOW), (e) => e.status === 404);
});

test('once the company expires, its boards stop being readable', async () => {
  reset();
  const { org, board } = await seedBoard({ orgOver: { startsAt: '2026-01-01', expiresAt: '2099-01-01' } });
  db.organization[0].expiresAt = new Date('2026-12-05T00:00:00Z');
  await assert.rejects(boards.getBoardStandings(org.id, board.id, 11, NOW), (e) => e.status === 404);
});

test('a board that has ended is still readable, frozen at its end day', async () => {
  reset();
  const { org, board } = await seedBoard({ boardOver: { endsAt: '2026-12-05T00:00:00Z' } });
  const out = await boards.getBoardStandings(org.id, board.id, 11, NOW);
  assert.equal(out.leaderboard.status, 'ended');
});

test('an archived board is hidden from members', async () => {
  reset();
  const { org, board } = await seedBoard();
  await svc.updateLeaderboard(org.id, board.id, { status: 'archived' });
  await assert.rejects(boards.getBoardStandings(org.id, board.id, 11, NOW), (e) => e.status === 404);
  const mine = await svc.getMyOrganizations(11);
  assert.equal(mine[0].leaderboards.length, 0);
});

test('when health data cannot be read the result says so instead of passing off low scores as final', async () => {
  reset();
  const { org, board } = await seedBoard();
  activity = { data: {}, complete: false };
  const out = await boards.getBoardStandings(org.id, board.id, 11, NOW);
  assert.equal(out.complete, false);
});

test('an opted-out member can still open the board but is not ranked', async () => {
  reset();
  const { org, board } = await seedBoard();
  const out = await boards.getBoardStandings(org.id, board.id, 33, NOW);
  assert.equal(out.me.rank, null);
  assert.equal(out.me.hidden, true);
});
