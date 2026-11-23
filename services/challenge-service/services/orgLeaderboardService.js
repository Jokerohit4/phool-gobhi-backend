import prisma from '../db/prisma.js';
import { fetchUsersByIds, fetchOrgActivity } from './orgDirectory.js';
import { effectiveOrgStatus, leaderboardWindow, istDayStartUtc, istDayEndExclusiveUtc } from '../utils/orgWindow.js';
import { scoreMember, rankMembers, rankTeams, displayNameFor } from './orgScoring.js';
import { serializeBoard } from './orgService.js';

// Standings for one company leaderboard. Only people on the member list are
// ever ranked, and only members can read a board (checked on every call).

// Standings cost a fan-out to auth-service and health-service, so one computed
// result is shared by every viewer for a short time. A result built from an
// incomplete health read is never cached.
const CACHE_TTL_MS = process.env.NODE_TEST_CONTEXT ? 0 : 60_000;
const CACHE_MAX = 200;
const cache = new Map(); // `${boardId}:${windowEnd}` -> { at, value }

export function clearOrgBoardCache() { cache.clear(); }

async function computeStandings(board, org, win) {
  const members = await prisma.organizationMember.findMany({
    where: { orgId: org.id, status: 'active', userId: { not: null } },
    include: { team: true },
  });
  const userIds = members.map((m) => m.userId);
  const users = await fetchUsersByIds(userIds);
  // Opt-out is respected here too: someone who hides themselves from
  // leaderboards is not ranked or shown, even on a company board.
  const ranked = members.filter((m) => users[m.userId] && users[m.userId].leaderboardOptIn !== false);
  const rankedIds = ranked.map((m) => m.userId);

  let attendance = [];
  let activity = { data: {}, complete: true };
  if (win.status !== 'upcoming' && rankedIds.length) {
    [attendance, activity] = await Promise.all([
      prisma.attendanceEventLog.findMany({
        where: {
          userId: { in: rankedIds },
          attendedAt: { gte: istDayStartUtc(win.startDay), lt: istDayEndExclusiveUtc(win.endDay) },
        },
        select: { userId: true, attendedAt: true },
      }),
      fetchOrgActivity(rankedIds, win.startDay, win.endDay),
    ]);
  }
  const attendanceByUser = new Map();
  for (const row of attendance) {
    const day = new Date(row.attendedAt.getTime() + 330 * 60000).toISOString().slice(0, 10);
    if (!attendanceByUser.has(row.userId)) attendanceByUser.set(row.userId, new Set());
    attendanceByUser.get(row.userId).add(day);
  }

  const rows = ranked.map((m) => {
    const a = activity.data[m.userId] ?? {};
    const scored = scoreMember({
      scoring: board.scoring,
      attendanceDays: [...(attendanceByUser.get(m.userId) ?? [])],
      workoutDays: a.workoutDays ?? [],
      stepsByDay: a.stepsByDay ?? {},
      startDay: win.startDay, endDay: win.endDay,
    });
    return {
      userId: m.userId, name: users[m.userId].name, teamId: m.teamId, teamName: m.team?.name ?? null, ...scored,
    };
  });
  return {
    members: rankMembers(rows),
    teams: board.showTeams ? rankTeams(rows) : [],
    complete: activity.complete,
  };
}

export async function getBoardStandings(orgId, boardId, requesterId, now = new Date()) {
  orgId = Number(orgId); boardId = Number(boardId);
  if (!Number.isInteger(orgId) || !Number.isInteger(boardId)) throw { status: 400, error: 'Invalid leaderboard' };

  // Membership is the access rule. Anything else looks like "not found" so the
  // existence of a company is not revealed to people outside it.
  const membership = await prisma.organizationMember.findFirst({
    where: { orgId, userId: requesterId, status: 'active' }, include: { team: true },
  });
  const board = membership
    ? await prisma.orgLeaderboard.findFirst({ where: { id: boardId, orgId }, include: { org: true } })
    : null;
  if (!membership || !board || board.status === 'archived' || effectiveOrgStatus(board.org, now) !== 'active') {
    throw { status: 404, error: 'Leaderboard not found' };
  }

  const win = leaderboardWindow(board, board.org, now);
  const key = `${board.id}:${win.endDay}:${board.scoring}:${board.showTeams}`;
  const hit = cache.get(key);
  let standings;
  if (CACHE_TTL_MS > 0 && hit && now.getTime() - hit.at < CACHE_TTL_MS) {
    standings = hit.value;
  } else {
    standings = await computeStandings(board, board.org, win);
    if (CACHE_TTL_MS > 0 && standings.complete) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now.getTime(), value: standings });
    }
  }

  const entries = standings.members.map((r) => ({
    rank: r.rank,
    name: displayNameFor(r.name, r.userId === requesterId),
    isMe: r.userId === requesterId,
    team: r.teamName,
    score: r.score,
    activeDays: r.activeDays,
  }));
  const mine = standings.members.find((r) => r.userId === requesterId);
  const myTeam = membership.teamId != null ? standings.teams.find((t) => t.teamId === membership.teamId) : null;
  return {
    leaderboard: serializeBoard(board, board.org, now),
    company: { id: board.org.id, name: board.org.name, expiresAt: board.org.expiresAt, unlimited: board.org.expiresAt == null },
    entries: entries.slice(0, 100),
    totalRanked: entries.length,
    teams: standings.teams.map((t) => ({ rank: t.rank, name: t.name, members: t.members, score: t.score, isMine: t.teamId === membership.teamId })),
    me: mine
      ? { rank: mine.rank, score: mine.score, activeDays: mine.activeDays, team: membership.team?.name ?? null, teamRank: myTeam?.rank ?? null }
      : { rank: null, score: 0, activeDays: 0, team: membership.team?.name ?? null, teamRank: null, hidden: true },
    // false = part of the data could not be read just now, so scores may read low.
    complete: standings.complete,
  };
}

// Same standings for staff, without the membership rule.
export async function getBoardStandingsAdmin(orgId, boardId, now = new Date()) {
  orgId = Number(orgId); boardId = Number(boardId);
  const board = await prisma.orgLeaderboard.findFirst({ where: { id: boardId, orgId }, include: { org: true } });
  if (!board) throw { status: 404, error: 'Leaderboard not found' };
  const win = leaderboardWindow(board, board.org, now);
  const standings = await computeStandings(board, board.org, win);
  return {
    leaderboard: serializeBoard(board, board.org, now),
    entries: standings.members.map((r) => ({
      rank: r.rank, userId: r.userId, name: r.name, team: r.teamName, score: r.score, activeDays: r.activeDays,
      workoutDays: r.workoutDays, steps: r.steps,
    })),
    teams: standings.teams,
    complete: standings.complete,
  };
}
