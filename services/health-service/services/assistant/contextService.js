import { PrismaClient } from '@prisma/client';
import { fetchAttendanceSince } from '../../utils/fetchAttendance.js';

const prisma = new PrismaClient();

// Hard ceiling on the user-context block. Without one, a user with two years
// of history quietly makes every one of their messages the most expensive
// message on the platform.
const MAX_CONTEXT_CHARS = 1800;
const ATTENDANCE_WINDOW_HOURS = 24 * 30;
const RECENT_SESSION_LIMIT = 10;

function pluralise(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/// A sentence, not a table. The model needs to know roughly how consistent
/// this person has been; handing it thirty raw event rows spends tokens to
/// say the same thing less clearly, and ships more personal data to a third
/// party than the answer requires.
function summariseAttendance(events) {
  if (!events.length) return 'No gym check-ins recorded in the last 30 days.';
  const sorted = [...events].sort(
    (a, b) => new Date(b.attendedAt) - new Date(a.attendedAt)
  );
  const days = new Set(
    sorted.map((e) => new Date(e.attendedAt).toISOString().slice(0, 10))
  ).size;
  const lastVisit = new Date(sorted[0].attendedAt);
  const daysAgo = Math.max(
    0,
    Math.floor((Date.now() - lastVisit.getTime()) / 86400000)
  );
  const when =
    daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
  return `Checked in on ${pluralise(days, 'day', 'days')} in the last 30 days; last visit ${when}.`;
}

/// Reduced by a deterministic formatter rather than a second model call.
/// Summarising with the model would double the cost and latency of every
/// message, and make the context non-reproducible for anyone debugging an
/// answer later.
function summariseSessions(sessions) {
  if (!sessions.length) return 'No logged workouts yet.';
  const lines = sessions.slice(0, 5).map((s) => {
    const date = s.startedAt.toISOString().slice(0, 10);
    const names = (s.exercises || [])
      .map((e) => e.exercise?.name)
      .filter(Boolean)
      .slice(0, 4);
    const setCount = (s.exercises || []).reduce(
      (n, e) => n + (e.sets?.length || 0),
      0
    );
    return `- ${date}: ${names.join(', ') || 'workout'} (${pluralise(setCount, 'set', 'sets')})`;
  });
  return `Recent workouts:\n${lines.join('\n')}`;
}

/// Everything the model is told about this user, assembled fresh each turn.
///
/// Injuries come from PersonalisationProfile.injuryZones — the field that
/// already exists and already has a consent gate — rather than being collected
/// a second time in chat. One place to revoke, one place to erase.
export async function buildUserContextService(userId) {
  const [events, sessions, personalisation, memories, weeklyGoal] = await Promise.all([
    fetchAttendanceSince(ATTENDANCE_WINDOW_HOURS, { userId }),
    prisma.workoutSession.findMany({
      where: { userId, endedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      take: RECENT_SESSION_LIMIT,
      include: { exercises: { include: { exercise: true, sets: true } } },
    }),
    prisma.personalisationProfile.findUnique({ where: { userId } }),
    prisma.assistantMemory.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
    prisma.weeklyGoal.findUnique({ where: { userId } }).catch(() => null),
  ]);

  const parts = [summariseAttendance(events), summariseSessions(sessions)];

  if (weeklyGoal?.sessionsPerWeek) {
    parts.push(`Weekly goal: ${pluralise(weeklyGoal.sessionsPerWeek, 'session', 'sessions')}.`);
  }
  if (personalisation?.experienceLevel) {
    parts.push(`Experience: ${personalisation.experienceLevel}.`);
  }
  if (personalisation?.injuryZones?.length) {
    parts.push(`Areas they have flagged as sensitive: ${personalisation.injuryZones.join(', ')}.`);
  }
  if (memories.length) {
    parts.push(
      `Things they have told the assistant:\n${memories
        .map((m) => `- ${m.key}: ${m.value}`)
        .join('\n')}`
    );
  }

  let text = parts.join('\n');
  if (text.length > MAX_CONTEXT_CHARS) {
    // Truncate rather than drop a whole section: losing the tail of a memory
    // list is better than silently losing attendance, which is the part that
    // makes answers specific to this person.
    text = `${text.slice(0, MAX_CONTEXT_CHARS)}…`;
  }

  return {
    text,
    // Counts and ids only — never the content. An audit trail that copies the
    // sensitive rows it audits has doubled the exposure it exists to control,
    // which is the same reasoning HealthDataAuditLog is built on.
    audit: {
      attendanceEvents: events.length,
      workoutSessions: sessions.length,
      injuryZones: personalisation?.injuryZones?.length ?? 0,
      memories: memories.length,
      contextChars: text.length,
    },
  };
}
