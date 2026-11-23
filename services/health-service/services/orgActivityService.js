import { isoDayIST, workoutElapsedSeconds } from '../utils/sessionDay.js';
import { isQualifyingSession } from './journey/showedUpDays.js';

// Per-day activity for a batch of people, for challenge-service's company
// leaderboards. Only day keys and step counts leave this service, never what a
// workout contained.
//
// Consent: everything here (workouts AND steps) is returned only for people
// with a live 'basic' coach consent. Everyone else comes back as
// `consented: false` and is not ranked, so joining a company board is an
// explicit opt-in to share activity, never something done to a member.
//
// Window is in IST calendar days ('YYYY-MM-DD', inclusive).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 400;

export function validateWindow(from, to) {
  if (!DAY_RE.test(String(from)) || !DAY_RE.test(String(to)) || from > to) {
    throw { status: 400, error: 'from and to must be YYYY-MM-DD with from <= to' };
  }
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (span > MAX_WINDOW_DAYS) throw { status: 400, error: `window must be at most ${MAX_WINDOW_DAYS} days` };
}

// Who has a live 'basic' coach consent. Entering a company leaderboard needs it:
// without it nothing about the person is read or ranked.
async function consentedUserIds(prisma, userIds) {
  const rows = await prisma.coachConsent.findMany({
    where: { userId: { in: userIds }, revokedAt: null }, select: { userId: true, scopes: true },
  });
  return new Set(rows.filter((c) => (c.scopes || []).includes('basic')).map((c) => c.userId));
}

export async function orgConsentForUsers(prisma, userIds) {
  const consented = await consentedUserIds(prisma, userIds);
  return Object.fromEntries(userIds.map((id) => [id, consented.has(id)]));
}

export async function orgActivityForUsers(prisma, { userIds, from, to }) {
  validateWindow(from, to);
  const start = new Date(`${from}T00:00:00+05:30`);
  const end = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400000);

  const [consented, sessions, steps] = await Promise.all([
    consentedUserIds(prisma, userIds),
    prisma.workoutSession.findMany({
      where: {
        userId: { in: userIds }, startedAt: { gte: start }, endedAt: { gte: start, lt: end }, NOT: { type: 'rest' },
      },
      select: {
        userId: true, startedAt: true, endedAt: true, type: true, activeSeconds: true, pausedSeconds: true,
        exercises: { select: { sets: { select: { completed: true } } } },
      },
    }),
    prisma.dailyActivityMetric.findMany({
      where: { userId: { in: userIds }, date: { gte: from, lte: to }, steps: { gt: 0 } },
      select: { userId: true, date: true, steps: true },
    }),
  ]);

  // People without consent come back as `consented: false` with NOTHING else:
  // no steps either, so a non-consenting member's data is never even read out.
  const out = Object.fromEntries(userIds.map((id) => [id, { consented: consented.has(id), workoutDays: [], stepsByDay: {} }]));

  const days = new Map();
  for (const s of sessions) {
    if (!consented.has(s.userId) || !isQualifyingSession(s)) continue;
    if ((s.activeSeconds ?? workoutElapsedSeconds(s)) < 600) continue;
    const day = isoDayIST(s.endedAt);
    if (day < from || day > to) continue;
    if (!days.has(s.userId)) days.set(s.userId, new Set());
    days.get(s.userId).add(day);
  }
  for (const [userId, set] of days) out[userId].workoutDays = [...set].sort();
  for (const row of steps) if (consented.has(row.userId)) out[row.userId].stepsByDay[row.date] = row.steps;
  return out;
}
