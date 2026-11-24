import prisma from '../db/prisma.js';
import { fetchUsersByIds, fetchOrgActivity } from './orgDirectory.js';
import { effectiveOrgStatus, istDay, istDayStartUtc, istDayEndExclusiveUtc } from '../utils/orgWindow.js';
import { serializeOrg, serializeBoard } from './orgService.js';
import { computeDashboardStats, participantDays, MIN_GROUP_SIZE } from './orgDashboardStats.js';

// The programme dashboard for one company (staff only). Gathers membership,
// consent, activity and check-ins, then hands them to the pure maths in
// orgDashboardStats.js.
//
// Only people who are linked, have NOT opted out of leaderboards and HAVE given
// health-data consent are counted as participants; everyone else is only a
// number in the funnel. The two staff action lists (not signed in yet, not
// consented yet) carry names/phones because following up with them is the point;
// no per-person activity is exposed here beyond what the leaderboard standings
// already show.

const ALLOWED_DAYS = [7, 30, 90];

export async function getOrgDashboard(orgId, { days } = {}, now = new Date()) {
  orgId = Number(orgId);
  if (!Number.isInteger(orgId) || orgId <= 0) throw { status: 400, error: 'Invalid company id' };
  const span = ALLOWED_DAYS.includes(Number(days)) ? Number(days) : 30;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: {
      teams: true,
      leaderboards: { where: { status: 'active' }, orderBy: { createdAt: 'desc' } },
      members: { where: { status: { in: ['active', 'invited'] } } },
    },
  });
  if (!org) throw { status: 404, error: 'Company not found' };

  // Window: the last `span` days, but never before the programme started, and
  // frozen at the expiry day once the profile has lapsed.
  const today = istDay(now);
  const lapsed = effectiveOrgStatus(org, now) === 'expired' && org.expiresAt;
  let endDay = lapsed ? istDay(new Date(new Date(org.expiresAt).getTime() - 1)) : today;
  if (endDay > today) endDay = today;
  const spanStart = istDay(new Date(istDayStartUtc(endDay).getTime() - (span - 1) * 86400000));
  const programmeStart = istDay(org.startsAt);
  let startDay = spanStart > programmeStart ? spanStart : programmeStart;
  const notStarted = startDay > endDay;
  if (notStarted) startDay = endDay;

  const linked = org.members.filter((m) => m.status === 'active' && m.userId != null);
  const invited = org.members.filter((m) => m.status === 'invited');
  const users = await fetchUsersByIds(linked.map((m) => m.userId));
  const optedIn = linked.filter((m) => users[m.userId] && users[m.userId].leaderboardOptIn !== false);
  const optedInIds = optedIn.map((m) => m.userId);

  const activity = optedInIds.length && !notStarted
    ? await fetchOrgActivity(optedInIds, startDay, endDay)
    : { data: {}, complete: true };
  const consentOf = (id) => activity.data[id]?.consented === true;
  // If activity/consent could not be read, count nobody rather than guess.
  const participantsMembers = notStarted || !activity.complete ? [] : optedIn.filter((m) => consentOf(m.userId));
  const participantIds = participantsMembers.map((m) => m.userId);

  const attendance = participantIds.length
    ? await prisma.attendanceEventLog.findMany({
        where: { userId: { in: participantIds }, attendedAt: { gte: istDayStartUtc(startDay), lt: istDayEndExclusiveUtc(endDay) } },
        select: { userId: true, attendedAt: true },
      })
    : [];
  const attendanceByUser = new Map();
  for (const row of attendance) {
    const day = istDay(row.attendedAt);
    if (!attendanceByUser.has(row.userId)) attendanceByUser.set(row.userId, []);
    attendanceByUser.get(row.userId).push(day);
  }

  const participants = participantsMembers.map((m) => {
    const a = activity.data[m.userId] ?? {};
    return {
      userId: m.userId, teamId: m.teamId,
      ...participantDays({
        attendanceDays: attendanceByUser.get(m.userId) ?? [], workoutDays: a.workoutDays ?? [],
        stepsByDay: a.stepsByDay ?? {}, startDay, endDay,
      }),
    };
  });

  const pending = activity.complete && !notStarted ? optedIn.filter((m) => !consentOf(m.userId)) : [];
  const stats = computeDashboardStats({
    participants,
    counts: {
      added: org.members.length,
      invited: invited.length,
      joined: linked.length,
      optedOut: linked.length - optedIn.length,
      pendingConsent: activity.complete && !notStarted ? pending.length : null,
    },
    teams: org.teams.map((t) => ({ id: t.id, name: t.name, added: org.members.filter((m) => m.teamId === t.id).length })),
    window: { startDay, endDay },
  });

  return {
    programme: serializeOrg(org, {}, now),
    leaderboards: org.leaderboards.map((b) => serializeBoard(b, org, now)),
    periodDays: span,
    notStarted,
    minGroupSize: MIN_GROUP_SIZE,
    stats,
    // Staff follow-up lists.
    actions: {
      notSignedIn: invited.map((m) => ({ phone: m.phone, name: m.displayName ?? null, addedAt: m.addedAt })),
      needsConsent: pending.map((m) => ({ name: users[m.userId]?.name ?? null, phone: users[m.userId]?.phone ?? m.phone })),
    },
    // false = consent/activity could not be read just now, so participants is empty.
    complete: activity.complete,
  };
}
