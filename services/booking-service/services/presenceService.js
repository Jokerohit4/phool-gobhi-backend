import prisma from '../db/prisma.js';
import { todayDateStringIST, IST_OFFSET_MS } from '../utils/slotTiming.js';
import { notifyPresence } from '../utils/notifyPresence.js';
import { whoIsInside, hourlyFlow, sessionsFromEvents, heatFromSessions, MAX_STAY_MS } from '../utils/presenceMath.js';

// Who is in a gym and who just came or went. Built on GymPresenceEvent: one row
// per entrance or exit, for members and for guests with a booking.

const HEAT_WEEKS = 8;
const RECENT_LIMIT = 20;

// Writes the event and, for an arrival or a departure, lets challenge-service
// know. Recording is best-effort: a gym visit must never fail because the log
// could not be written, so errors are logged and swallowed (the caller gets
// null). `awaitNotify` is for the check-out scan, whose answer carries the coins
// it just released.
export async function recordPresence({ gymId, customerId, kind, source, method, bookingId = null, at = new Date(), awaitNotify = false }) {
  let event = null;
  try {
    event = await prisma.gymPresenceEvent.create({
      data: { gymId, customerId, kind, source, method, bookingId, date: todayDateStringIST(at.getTime()), at },
    });
  } catch (err) {
    console.error('[presence] could not record', kind, 'for', customerId, 'at', gymId, err.message);
    return { event: null, released: 0 };
  }
  const payload = {
    userId: customerId, gymId, state: kind === 'in' ? 'in' : 'out', method, source,
    at: at.toISOString(), date: event.date,
  };
  if (!awaitNotify) {
    notifyPresence(payload);
    return { event, released: 0 };
  }
  const answer = await notifyPresence(payload);
  return { event, released: Number(answer?.released) || 0 };
}

// Where one person stands at one gym today: inside or not, since when, and
// whether anything has been recorded for them today at all (someone who checked
// in before this log existed has no events yet).
export async function openPresence(customerId, gymId, nowMs = Date.now()) {
  const date = todayDateStringIST(nowMs);
  const events = await prisma.gymPresenceEvent.findMany({
    where: { customerId, gymId, date },
    orderBy: { at: 'asc' },
  });
  const inside = whoIsInside(events, nowMs).get(customerId);
  return {
    inside: !!inside,
    since: inside ? new Date(inside.since) : null,
    source: inside?.source ?? null,
    bookingId: inside?.bookingId ?? null,
    hasEventsToday: events.length > 0,
  };
}

// Checks someone out by scanning the poster. The caller has already proved they
// are at the gym. Returns what the screen needs: when they came in, how long
// they stayed, and the coins this paid out.
export async function checkOutByScan({ gymId, customerId, now = new Date() }) {
  const open = await openPresence(customerId, gymId, now.getTime());
  if (!open.inside) {
    throw { status: 409, code: 'NOT_INSIDE', error: "You aren't checked in at this gym right now." };
  }
  const { released } = await recordPresence({
    gymId, customerId, kind: 'out', source: open.source ?? 'member', method: 'scan',
    bookingId: open.bookingId, at: now, awaitNotify: true,
  });
  return {
    kind: 'checkout',
    checkedInAt: open.since,
    checkedOutAt: now,
    minutesInside: Math.max(1, Math.round((now.getTime() - open.since.getTime()) / 60000)),
    coinsReleased: released,
  };
}

// The partner's live view: who is inside, who just arrived or left, today's flow
// per hour, and how today compares with the usual busy-ness at this hour.
// `nameOf` resolves display names for the customers named in the answer.
export async function liveSnapshot(gymId, { nowMs = Date.now(), nameOf = async () => ({}) } = {}) {
  const date = todayDateStringIST(nowMs);
  const since = new Date(nowMs - HEAT_WEEKS * 7 * 24 * 3600 * 1000);
  const [today, history] = await Promise.all([
    prisma.gymPresenceEvent.findMany({ where: { gymId, date }, orderBy: { at: 'asc' } }),
    prisma.gymPresenceEvent.findMany({ where: { gymId, at: { gte: since, lt: new Date(startOfIstDayMs(nowMs)) } }, orderBy: { at: 'asc' } }),
  ]);
  const inside = whoIsInside(today, nowMs);
  const recent = [...today].reverse().slice(0, RECENT_LIMIT);
  const ids = new Set([...inside.keys(), ...recent.map((e) => e.customerId)]);
  const names = ids.size ? await nameOf([...ids]) : {};
  const person = (id) => ({ customerId: id, name: names[id]?.name ?? null, photoUrl: names[id]?.photoUrl ?? null });

  const sessions = sessionsFromEvents([...history, ...today], nowMs);
  const heat = heatFromSessions(sessions, { weeks: HEAT_WEEKS, nowMs });
  const here = new Date(nowMs + IST_OFFSET_MS);
  const usual = heat.cells.find((c) => c.weekday === here.getUTCDay() && c.hour === here.getUTCHours());
  return {
    gymId,
    asOf: new Date(nowMs).toISOString(),
    date,
    insideCount: inside.size,
    inside: [...inside.entries()]
      .sort((a, b) => a[1].since - b[1].since)
      .map(([id, v]) => ({ ...person(id), since: new Date(v.since).toISOString(), kind: v.source === 'booking' ? 'guest' : 'member' })),
    recent: recent.map((e) => ({
      ...person(e.customerId), direction: e.kind, at: e.at.toISOString(),
      kind: e.source === 'booking' ? 'guest' : 'member', method: e.method,
    })),
    today: {
      arrivals: today.filter((e) => e.kind === 'in').length,
      departures: today.filter((e) => e.kind === 'out').length,
      hours: hourlyFlow(today, date),
    },
    usualNow: usual ? { avgPresent: usual.avgPresent, hour: usual.hour } : null,
    heat: { weeks: heat.weeks, cells: heat.cells, peak: heat.peak },
    maxStayMinutes: MAX_STAY_MS / 60000,
  };
}

function startOfIstDayMs(nowMs) {
  const shifted = nowMs + IST_OFFSET_MS;
  return Math.floor(shifted / 86400000) * 86400000 - IST_OFFSET_MS;
}
