import prisma from '../db/prisma.js';
import { normalizePhone, lookupUserIdByPhone, fetchUsersByIds, fetchOrgConsent } from './orgDirectory.js';
import { effectiveOrgStatus, daysLeft, leaderboardWindow, parseOptionalDate } from '../utils/orgWindow.js';

// Corporate-wellness organizations: company profile lifecycle, private
// membership, teams and leaderboard definitions. Standings live in
// orgLeaderboardService.

const MAX_MEMBERS_PER_REQUEST = 500;
const NAME_MIN = 2;
const NAME_MAX = 80;

function cleanName(value, field = 'name') {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    throw { status: 400, error: `${field} must be ${NAME_MIN}-${NAME_MAX} characters` };
  }
  return name;
}

function optionalText(value, max, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (text.length > max) throw { status: 400, error: `${field} is too long` };
  return text || null;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'company';
}

async function uniqueSlug(name) {
  const base = slugify(name);
  for (let n = 0; n < 50; n += 1) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    if (!await prisma.organization.findUnique({ where: { slug }, select: { id: true } })) return slug;
  }
  throw { status: 409, error: 'Could not generate a unique company slug' };
}

function intId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw { status: 400, error: `Invalid ${label}` };
  return id;
}

// ---- Lifecycle ------------------------------------------------------------

// Persist "this profile has lapsed". Expiry is decided from the dates on every
// read, so this only keeps the stored status and convertedAt honest for staff
// views and reports. Idempotent and cheap.
export async function sweepExpiredOrgs(now = new Date()) {
  const { count } = await prisma.organization.updateMany({
    where: { status: 'active', expiresAt: { lte: now } },
    data: { status: 'expired', convertedAt: now },
  });
  return count;
}

function serializeOrg(org, counts = {}, now = new Date()) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: effectiveOrgStatus(org, now),
    startsAt: org.startsAt,
    expiresAt: org.expiresAt,
    unlimited: org.expiresAt == null,
    daysLeft: daysLeft(org, now),
    convertedAt: org.convertedAt,
    contactName: org.contactName,
    contactEmail: org.contactEmail,
    notes: org.notes,
    createdAt: org.createdAt,
    ...counts,
  };
}

export async function createOrg({ name, startsAt, expiresAt, contactName, contactEmail, notes }, adminId) {
  const cleaned = cleanName(name);
  const start = parseOptionalDate(startsAt, 'startsAt') ?? new Date();
  const expires = parseOptionalDate(expiresAt, 'expiresAt') ?? null;
  if (expires && expires <= start) throw { status: 400, error: 'expiresAt must be after startsAt' };
  const org = await prisma.organization.create({
    data: {
      name: cleaned,
      slug: await uniqueSlug(cleaned),
      startsAt: start,
      expiresAt: expires,
      contactName: optionalText(contactName, 120, 'contactName') ?? null,
      contactEmail: optionalText(contactEmail, 160, 'contactEmail') ?? null,
      notes: optionalText(notes, 2000, 'notes') ?? null,
      createdBy: adminId,
    },
  });
  return serializeOrg(org, { activeMembers: 0, invitedMembers: 0, leaderboards: 0 });
}

export async function updateOrg(orgId, patch) {
  orgId = intId(orgId, 'company id');
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw { status: 404, error: 'Company not found' };
  const data = {};
  if (patch.name !== undefined) data.name = cleanName(patch.name);
  for (const [key, max] of [['contactName', 120], ['contactEmail', 160], ['notes', 2000]]) {
    const v = optionalText(patch[key], max, key);
    if (v !== undefined) data[key] = v;
  }
  const expires = parseOptionalDate(patch.expiresAt, 'expiresAt');
  if (expires !== undefined) {
    data.expiresAt = expires;
    // Extending (or removing) the expiry brings a lapsed profile back.
    if ((expires === null || expires > new Date()) && org.status === 'expired') {
      data.status = 'active';
      data.convertedAt = null;
    }
  }
  if (patch.status !== undefined) {
    if (!['active', 'archived'].includes(patch.status)) {
      throw { status: 400, error: 'status must be active or archived' };
    }
    data.status = patch.status;
  }
  const effectiveStart = patch.startsAt !== undefined ? parseOptionalDate(patch.startsAt, 'startsAt') : undefined;
  if (effectiveStart) data.startsAt = effectiveStart;
  const finalExpires = data.expiresAt === undefined ? org.expiresAt : data.expiresAt;
  const finalStart = data.startsAt ?? org.startsAt;
  if (finalExpires && finalExpires <= finalStart) throw { status: 400, error: 'expiresAt must be after startsAt' };
  const saved = await prisma.organization.update({ where: { id: orgId }, data });
  return serializeOrg(saved);
}

export async function listOrgs(now = new Date()) {
  await sweepExpiredOrgs(now);
  const orgs = await prisma.organization.findMany({ orderBy: { createdAt: 'desc' } });
  if (!orgs.length) return [];
  const [members, boards] = await Promise.all([
    prisma.organizationMember.groupBy({
      by: ['orgId', 'status'], where: { orgId: { in: orgs.map((o) => o.id) }, status: { in: ['active', 'invited'] } },
      _count: { _all: true },
    }),
    prisma.orgLeaderboard.groupBy({
      by: ['orgId'], where: { orgId: { in: orgs.map((o) => o.id) }, status: 'active' }, _count: { _all: true },
    }),
  ]);
  const count = (orgId, status) => members.find((m) => m.orgId === orgId && m.status === status)?._count._all ?? 0;
  return orgs.map((o) => serializeOrg(o, {
    activeMembers: count(o.id, 'active'),
    invitedMembers: count(o.id, 'invited'),
    leaderboards: boards.find((b) => b.orgId === o.id)?._count._all ?? 0,
  }, now));
}

export async function getOrgDetail(orgId, now = new Date()) {
  orgId = intId(orgId, 'company id');
  await sweepExpiredOrgs(now);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: {
      teams: { orderBy: { name: 'asc' } },
      leaderboards: { orderBy: { createdAt: 'desc' } },
      members: { where: { status: { in: ['active', 'invited'] } }, orderBy: { addedAt: 'asc' } },
    },
  });
  if (!org) throw { status: 404, error: 'Company not found' };
  let users = {};
  try { users = await fetchUsersByIds(org.members.map((m) => m.userId).filter((v) => v != null)); } catch (_) { /* names are best-effort for staff */ }
  const teamName = new Map(org.teams.map((t) => [t.id, t.name]));
  return {
    ...serializeOrg(org, {
      activeMembers: org.members.filter((m) => m.status === 'active').length,
      invitedMembers: org.members.filter((m) => m.status === 'invited').length,
      leaderboards: org.leaderboards.filter((b) => b.status === 'active').length,
    }, now),
    teams: org.teams.map((t) => ({ id: t.id, name: t.name, members: org.members.filter((m) => m.teamId === t.id).length })),
    members: org.members.map((m) => ({
      id: m.id, phone: m.phone, status: m.status, userId: m.userId,
      name: users[m.userId]?.name ?? m.displayName ?? null,
      teamId: m.teamId, teamName: m.teamId ? teamName.get(m.teamId) ?? null : null,
      addedAt: m.addedAt, joinedAt: m.joinedAt,
    })),
    leaderboards: org.leaderboards.map((b) => serializeBoard(b, org, now)),
  };
}

// ---- Members --------------------------------------------------------------

async function ensureTeam(orgId, teamName, cache) {
  const name = cleanName(teamName, 'team');
  if (cache.has(name)) return cache.get(name);
  const team = await prisma.organizationTeam.upsert({
    where: { orgId_name: { orgId, name } }, update: {}, create: { orgId, name },
  });
  cache.set(name, team.id);
  return team.id;
}

// Add people by phone. Rows are independent: a bad row is reported and the
// rest still go through. A phone that already has an account becomes an active
// member straight away; any other stays `invited` until that person signs up.
export async function addMembers(orgId, rows, adminId) {
  orgId = intId(orgId, 'company id');
  if (!Array.isArray(rows) || rows.length === 0) throw { status: 400, error: 'members must be a non-empty list' };
  if (rows.length > MAX_MEMBERS_PER_REQUEST) {
    throw { status: 400, error: `Add at most ${MAX_MEMBERS_PER_REQUEST} members at a time` };
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw { status: 404, error: 'Company not found' };
  if (effectiveOrgStatus(org) !== 'active') throw { status: 409, error: 'This company profile is not active' };

  const result = { added: 0, linked: 0, invited: 0, reactivated: 0, alreadyMember: 0, invalid: [] };
  const teamCache = new Map();
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const phone = normalizePhone(row?.phone);
    if (!phone) { result.invalid.push({ row: index + 1, phone: row?.phone ?? null, reason: 'invalid_phone' }); continue; }
    if (seen.has(phone)) { result.invalid.push({ row: index + 1, phone, reason: 'duplicate_in_request' }); continue; }
    seen.add(phone);
    try {
      const teamId = row.team ? await ensureTeam(orgId, row.team, teamCache) : null;
      const existing = await prisma.organizationMember.findUnique({ where: { orgId_phone: { orgId, phone } } });
      if (existing && existing.status !== 'removed') {
        if (teamId != null && existing.teamId !== teamId) {
          await prisma.organizationMember.update({ where: { id: existing.id }, data: { teamId } });
        }
        result.alreadyMember += 1;
        continue;
      }
      const userId = await lookupUserIdByPhone(phone);
      const data = {
        userId, status: userId ? 'active' : 'invited', joinedAt: userId ? new Date() : null,
        removedAt: null, ...(teamId != null ? { teamId } : {}),
        displayName: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 80) : existing?.displayName ?? null,
        addedBy: adminId,
      };
      if (existing) { await prisma.organizationMember.update({ where: { id: existing.id }, data }); result.reactivated += 1; }
      else { await prisma.organizationMember.create({ data: { orgId, phone, ...data } }); result.added += 1; }
      if (userId) result.linked += 1; else result.invited += 1;
    } catch (err) {
      if (err?.status === 503) throw err; // accounts service down: stop, do not mis-record people as invited
      result.invalid.push({ row: index + 1, phone, reason: err?.error || 'failed' });
    }
  }
  return result;
}

export async function removeMember(orgId, memberId) {
  orgId = intId(orgId, 'company id'); memberId = intId(memberId, 'member id');
  const member = await prisma.organizationMember.findFirst({ where: { id: memberId, orgId } });
  if (!member) throw { status: 404, error: 'Member not found' };
  await prisma.organizationMember.update({
    where: { id: memberId }, data: { status: 'removed', removedAt: new Date(), teamId: null },
  });
  return { removed: true };
}

export async function setMemberTeam(orgId, memberId, teamId) {
  orgId = intId(orgId, 'company id'); memberId = intId(memberId, 'member id');
  const member = await prisma.organizationMember.findFirst({ where: { id: memberId, orgId } });
  if (!member) throw { status: 404, error: 'Member not found' };
  let target = null;
  if (teamId !== null && teamId !== undefined) {
    target = intId(teamId, 'team id');
    if (!await prisma.organizationTeam.findFirst({ where: { id: target, orgId }, select: { id: true } })) {
      throw { status: 404, error: 'Team not found' };
    }
  }
  await prisma.organizationMember.update({ where: { id: memberId }, data: { teamId: target } });
  return { teamId: target };
}

// ---- Teams ----------------------------------------------------------------

export async function createTeam(orgId, name) {
  orgId = intId(orgId, 'company id');
  if (!await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } })) {
    throw { status: 404, error: 'Company not found' };
  }
  const cleaned = cleanName(name, 'team name');
  try {
    const team = await prisma.organizationTeam.create({ data: { orgId, name: cleaned } });
    return { id: team.id, name: team.name, members: 0 };
  } catch (err) {
    if (err?.code === 'P2002') throw { status: 409, error: 'A team with that name already exists' };
    throw err;
  }
}

export async function renameTeam(orgId, teamId, name) {
  orgId = intId(orgId, 'company id'); teamId = intId(teamId, 'team id');
  if (!await prisma.organizationTeam.findFirst({ where: { id: teamId, orgId }, select: { id: true } })) {
    throw { status: 404, error: 'Team not found' };
  }
  try {
    const team = await prisma.organizationTeam.update({ where: { id: teamId }, data: { name: cleanName(name, 'team name') } });
    return { id: team.id, name: team.name };
  } catch (err) {
    if (err?.code === 'P2002') throw { status: 409, error: 'A team with that name already exists' };
    throw err;
  }
}

export async function deleteTeam(orgId, teamId) {
  orgId = intId(orgId, 'company id'); teamId = intId(teamId, 'team id');
  if (!await prisma.organizationTeam.findFirst({ where: { id: teamId, orgId }, select: { id: true } })) {
    throw { status: 404, error: 'Team not found' };
  }
  await prisma.organizationTeam.delete({ where: { id: teamId } }); // members fall back to "no team"
  return { deleted: true };
}

// ---- Leaderboards ---------------------------------------------------------

const SCORING = ['active_days', 'workout_days', 'steps'];

export function serializeBoard(board, org, now = new Date()) {
  const w = leaderboardWindow(board, org, now);
  return {
    id: board.id, orgId: board.orgId, name: board.name, description: board.description,
    scoring: board.scoring, showTeams: board.showTeams, status: w.status,
    startsAt: board.startsAt, endsAt: w.endsAt, unlimited: w.unlimited,
    // The board's own setting, separate from the effective end above (which
    // may be earlier because the company profile expires first).
    configuredEndsAt: board.endsAt, archived: board.status === 'archived',
  };
}

export async function createLeaderboard(orgId, input, adminId) {
  orgId = intId(orgId, 'company id');
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw { status: 404, error: 'Company not found' };
  const scoring = input.scoring ?? 'active_days';
  if (!SCORING.includes(scoring)) throw { status: 400, error: `scoring must be one of ${SCORING.join(', ')}` };
  const startsAt = parseOptionalDate(input.startsAt, 'startsAt') ?? new Date();
  const endsAt = parseOptionalDate(input.endsAt, 'endsAt') ?? null; // null = unlimited
  if (endsAt && endsAt <= startsAt) throw { status: 400, error: 'endsAt must be after startsAt' };
  const board = await prisma.orgLeaderboard.create({
    data: {
      orgId, name: cleanName(input.name), description: optionalText(input.description, 500, 'description') ?? null,
      scoring, startsAt, endsAt, showTeams: input.showTeams !== false, createdBy: adminId,
    },
  });
  return serializeBoard(board, org);
}

export async function updateLeaderboard(orgId, boardId, patch) {
  orgId = intId(orgId, 'company id'); boardId = intId(boardId, 'leaderboard id');
  const board = await prisma.orgLeaderboard.findFirst({ where: { id: boardId, orgId }, include: { org: true } });
  if (!board) throw { status: 404, error: 'Leaderboard not found' };
  const data = {};
  if (patch.name !== undefined) data.name = cleanName(patch.name);
  const description = optionalText(patch.description, 500, 'description');
  if (description !== undefined) data.description = description;
  if (patch.scoring !== undefined) {
    if (!SCORING.includes(patch.scoring)) throw { status: 400, error: `scoring must be one of ${SCORING.join(', ')}` };
    data.scoring = patch.scoring;
  }
  if (patch.showTeams !== undefined) data.showTeams = !!patch.showTeams;
  if (patch.status !== undefined) {
    if (!['active', 'archived'].includes(patch.status)) throw { status: 400, error: 'status must be active or archived' };
    data.status = patch.status;
  }
  const startsAt = parseOptionalDate(patch.startsAt, 'startsAt');
  if (startsAt) data.startsAt = startsAt;
  const endsAt = parseOptionalDate(patch.endsAt, 'endsAt'); // null = make it unlimited
  if (endsAt !== undefined) data.endsAt = endsAt;
  const finalStart = data.startsAt ?? board.startsAt;
  const finalEnd = data.endsAt === undefined ? board.endsAt : data.endsAt;
  if (finalEnd && finalEnd <= finalStart) throw { status: 400, error: 'endsAt must be after startsAt' };
  const saved = await prisma.orgLeaderboard.update({ where: { id: boardId }, data });
  return serializeBoard(saved, board.org);
}

// ---- Member-facing --------------------------------------------------------

// Link invites to the account that just appeared. Runs when the user opens the
// company section, so no cross-service hook is needed at signup. Best-effort:
// a failure leaves them unlinked and the next open retries.
// The company card asks on every app open, and checking for invites costs a
// call to the accounts service, so each user is checked at most once a minute.
// (Off under `node --test` so tests see every call.)
const CLAIM_CHECK_TTL_MS = process.env.NODE_TEST_CONTEXT ? 0 : 60_000;
const CLAIM_CHECK_MAX = 5000;
const lastClaimCheck = new Map(); // userId -> ms

export async function claimInvites(userId) {
  if (CLAIM_CHECK_TTL_MS > 0) {
    const last = lastClaimCheck.get(userId);
    if (last && Date.now() - last < CLAIM_CHECK_TTL_MS) return 0;
    if (lastClaimCheck.size >= CLAIM_CHECK_MAX) lastClaimCheck.delete(lastClaimCheck.keys().next().value);
    lastClaimCheck.set(userId, Date.now());
  }
  try {
    const user = (await fetchUsersByIds([userId]))[userId];
    const phone = normalizePhone(user?.phone);
    if (!phone) return 0;
    const { count } = await prisma.organizationMember.updateMany({
      where: { phone, status: 'invited' },
      data: { userId, status: 'active', joinedAt: new Date() },
    });
    return count;
  } catch (_) {
    return 0;
  }
}

// Companies this user belongs to right now. Expired, archived and removed
// memberships are simply absent: that is what "turns into a normal one" means.
export async function getMyOrganizations(userId, now = new Date()) {
  await claimInvites(userId);
  await sweepExpiredOrgs(now);
  const memberships = (await prisma.organizationMember.findMany({
    where: { userId, status: 'active' },
    include: {
      team: true,
      org: { include: { leaderboards: { where: { status: 'active' }, orderBy: { createdAt: 'desc' } } } },
    },
    // Same expiry rule as everywhere else, so a lapsed profile disappears the
    // moment it lapses, not when the sweep next runs.
  })).filter((m) => effectiveOrgStatus(m.org, now) === 'active');
  // One light check, only when there is a company to show: has this person
  // given the health-data consent that entering a leaderboard needs? null =
  // could not be checked just now (the app then asks nothing rather than nags).
  let needsConsent = null;
  if (memberships.length) {
    const c = await fetchOrgConsent([userId]);
    if (c.complete) needsConsent = c.data[userId] !== true;
  }
  return memberships.map((m) => ({
    id: m.org.id, name: m.org.name, needsConsent, expiresAt: m.org.expiresAt, unlimited: m.org.expiresAt == null,
    daysLeft: daysLeft(m.org, now),
    team: m.team ? { id: m.team.id, name: m.team.name } : null,
    leaderboards: m.org.leaderboards.map((b) => serializeBoard(b, m.org, now)),
  }));
}

export { MAX_MEMBERS_PER_REQUEST };
