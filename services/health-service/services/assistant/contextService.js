import { PrismaClient } from '@prisma/client';
import { fetchAttendanceSince } from '../../utils/fetchAttendance.js';
import { tierOf, orderMemories } from './memoryService.js';

const prisma = new PrismaClient();

// Hard ceiling on the user-context block. Without one, a user with two years
// of history quietly makes every one of their messages the most expensive
// message on the platform.
//
// Sized so the worst case fits without truncation ever firing: every memory key
// at its cap (25 rows x 80 chars = ~2,500) plus attendance and five recent
// workouts. Truncation below is a backstop now, not something the design leans
// on to stay inside budget — which matters because the thing it would cut is a
// user's own remembered facts.
const MAX_CONTEXT_CHARS = 3400;
const ATTENDANCE_WINDOW_HOURS = 24 * 30;
const RECENT_SESSION_LIMIT = 10;

function pluralise(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Attendance timestamps are UTC, but a training pattern only means anything in
// the user's own wall clock. A 7am IST session is 01:30 UTC — read as UTC it
// lands in "late night" AND on the previous weekday, so both halves of the
// pattern would be wrong. Everything below is computed from IST parts.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Below this many distinct days, a day-of-week or time-of-day "pattern" is
// noise, and stating it as fact makes the coach confidently wrong about the
// one thing it is supposed to know better than the user.
const MIN_DAYS_FOR_PATTERN = 6;

function istParts(value) {
  const d = new Date(new Date(value).getTime() + IST_OFFSET_MS);
  return {
    ymd: d.toISOString().slice(0, 10),
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
  };
}

function timeBucket(hour) {
  if (hour < 5) return 'late at night';
  if (hour < 11) return 'in the mornings';
  if (hour < 16) return 'around midday';
  if (hour < 21) return 'in the evenings';
  return 'late at night';
}

/// Shape, not rows. The model needs to know how consistent this person has
/// been AND when they actually train — habit coaching is pattern work, and
/// "11 days in 30" cannot tell you they always miss Thursdays.
///
/// Still an aggregate: no dates, no gym, nothing linkable. A day-of-week and
/// time-of-day shape is arguably *less* identifying than thirty raw
/// timestamps, while being the part that makes the advice specific.
/// Exported for the tests: the alternative is standing up a Prisma mock and a
/// cross-service HTTP stub to assert one sentence.
export function summariseAttendance(events) {
  if (!events.length) return 'No gym check-ins recorded in the last 30 days.';

  // One entry per calendar day — two sessions in a day is one day of training,
  // and counting it twice would skew every ratio below.
  const byDay = new Map();
  for (const e of events) {
    const p = istParts(e.attendedAt);
    if (!byDay.has(p.ymd)) byDay.set(p.ymd, p);
  }
  const days = [...byDay.keys()].sort();
  const n = days.length;
  const weeks = ATTENDANCE_WINDOW_HOURS / 24 / 7;
  const perWeek = Math.round((n / weeks) * 10) / 10;

  const sentences = [
    `Trained on ${pluralise(n, 'day', 'days')} in the last 30 (about ${perWeek} a week).`,
  ];

  if (n >= MIN_DAYS_FOR_PATTERN) {
    const dowCounts = new Array(7).fill(0);
    const buckets = new Map();
    for (const p of byDay.values()) {
      dowCounts[p.dow] += 1;
      const b = timeBucket(p.hour);
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }

    // Days they actually repeat on, most-frequent first, then re-ordered
    // Mon-first so it reads like a week rather than a ranking.
    const regular = dowCounts
      .map((count, dow) => ({ count, dow }))
      .filter((d) => d.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .sort((a, b) => ((a.dow + 6) % 7) - ((b.dow + 6) % 7))
      .map((d) => DAY_NAMES[d.dow]);

    const [topBucket, topCount] = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
    // Only claim a time-of-day habit when it actually dominates; someone split
    // evenly between mornings and evenings has no such habit to report.
    const bucketPhrase = topCount / n >= 0.6 ? `, mostly ${topBucket}` : '';

    if (regular.length) {
      sentences.push(`Usually ${regular.join(', ')}${bucketPhrase}.`);
    } else if (bucketPhrase) {
      sentences.push(`Trains${bucketPhrase.slice(2)}.`);
    }

    // The most actionable single number for habit work: how long they go
    // before falling off. Gaps are between training days inside the window.
    let longestGap = 0;
    for (let i = 1; i < days.length; i++) {
      const gap = Math.round(
        (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000
      );
      if (gap > longestGap) longestGap = gap;
    }
    if (longestGap >= 3) {
      sentences.push(`Longest break ${pluralise(longestGap, 'day', 'days')}.`);
    }
  }

  const lastVisit = new Date(
    Math.max(...events.map((e) => new Date(e.attendedAt).getTime()))
  );
  const daysAgo = Math.max(
    0,
    Math.floor((Date.now() - lastVisit.getTime()) / 86400000)
  );
  const when =
    daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
  sentences.push(`Last session ${when}.`);

  return sentences.join(' ');
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
    // No orderBy: orderMemories below imposes the stable (tier, key, id) order
    // the prompt needs, and ordering by updatedAt here would only reshuffle the
    // block every time a fact was restated — breaking the cached prefix.
    prisma.assistantMemory.findMany({ where: { userId } }),
    prisma.weeklyGoal.findUnique({ where: { userId } }).catch(() => null),
  ]);

  // Every memory, every turn — no retrieval step.
  //
  // KEY_POLICY caps a user at 25 rows of 80 characters, so the whole store is
  // ~2,500 characters at its absolute worst and simply fits. Selecting from it
  // would be machinery for a problem the caps already solve, and on this
  // provider it actively costs more than it saves: a memory block that varies
  // with the message breaks the cached prompt prefix, moving everything after
  // it from half-price-and-rate-limit-exempt to full price. It would also add
  // a way to silently miss an allergy, which is worth no saving at all.
  //
  // Order is stable (tier, key, id) so the block is byte-identical between
  // turns and that prefix keeps caching.
  const ordered = orderMemories(memories);
  const byTier = (t) => ordered.filter((m) => tierOf(m.key) === t);
  const renderMemories = (rows) =>
    rows.map((m) => `- ${m.key}: ${m.value}`).join('\n');

  const safety = byTier(1);
  const parts = [];
  if (safety.length) {
    parts.push(`Important — they have told the assistant:\n${renderMemories(safety)}`);
  }
  parts.push(summariseAttendance(events), summariseSessions(sessions));

  if (weeklyGoal?.sessionsPerWeek) {
    parts.push(`Weekly goal: ${pluralise(weeklyGoal.sessionsPerWeek, 'session', 'sessions')}.`);
  }
  if (personalisation?.experienceLevel) {
    parts.push(`Experience: ${personalisation.experienceLevel}.`);
  }
  if (personalisation?.injuryZones?.length) {
    parts.push(`Areas they have flagged as sensitive: ${personalisation.injuryZones.join(', ')}.`);
  }
  // Tiers 2 and 3 at the end. Nothing is expected to be cut now that the
  // budget fits the worst case, but if a future change makes truncation bite,
  // it should bite preferences rather than the safety block above.
  const rest = [...byTier(2), ...byTier(3)];
  if (rest.length) {
    parts.push(`Things they have told the assistant:\n${renderMemories(rest)}`);
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
