import { IST_OFFSET_MS } from './slotTiming.js';

// Pure arithmetic over GymPresenceEvent rows, kept free of Prisma and the clock
// so the rules can be tested directly. Every function takes `nowMs`.

const HOUR_MS = 60 * 60 * 1000;

// Someone whose last event is an arrival is "in the gym" for at most this long.
// People leave without telling us (that is allowed), so an arrival with no
// departure cannot keep a person on the live count forever.
export const MAX_STAY_MS = 6 * HOUR_MS;

// For the heat map only: an arrival with no recorded departure is assumed to
// have lasted this long, so a gym whose members rarely scan out still gets a
// believable busy-ness picture instead of an empty one.
export const ASSUMED_STAY_MS = 90 * 60 * 1000;

// IST wall-clock fields of an instant: { dateKey: 'YYYY-MM-DD', weekday: 0-6
// (Sunday = 0), hour: 0-23 }.
export function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    dateKey: d.toISOString().slice(0, 10),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
  };
}

function atMs(e) {
  return e.at instanceof Date ? e.at.getTime() : new Date(e.at).getTime();
}

// Who is inside right now, from today's events. Events may arrive in any order.
// Returns a Map of customerId -> { since, source, bookingId }.
export function whoIsInside(events, nowMs) {
  const last = new Map();
  for (const e of [...events].sort((a, b) => atMs(a) - atMs(b))) last.set(e.customerId, e);
  const inside = new Map();
  for (const [customerId, e] of last) {
    if (e.kind !== 'in') continue;
    if (nowMs - atMs(e) > MAX_STAY_MS) continue;
    inside.set(customerId, { since: atMs(e), source: e.source, bookingId: e.bookingId ?? null });
  }
  return inside;
}

// Arrivals and departures per IST hour for one IST day.
export function hourlyFlow(events, dateKey) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, arrivals: 0, departures: 0 }));
  for (const e of events) {
    const p = istParts(atMs(e));
    if (p.dateKey !== dateKey) continue;
    if (e.kind === 'in') hours[p.hour].arrivals += 1;
    else if (e.kind === 'out') hours[p.hour].departures += 1;
  }
  return hours;
}

// Pairs each arrival with the departure that follows it for the same person at
// the same gym. An arrival with no departure ends when the person next arrives,
// or after ASSUMED_STAY_MS, or at `nowMs` if they are still inside.
export function sessionsFromEvents(events, nowMs) {
  const byPerson = new Map();
  for (const e of [...events].sort((a, b) => atMs(a) - atMs(b))) {
    if (!byPerson.has(e.customerId)) byPerson.set(e.customerId, []);
    byPerson.get(e.customerId).push(e);
  }
  const sessions = [];
  for (const [customerId, list] of byPerson) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind !== 'in') continue;
      const start = atMs(list[i]);
      let end = null;
      let closed = false;
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].kind === 'out') { end = atMs(list[j]); closed = true; }
        // Another arrival before any departure: the first stay ended unrecorded.
        else { end = Math.min(atMs(list[j]), start + ASSUMED_STAY_MS); }
        break;
      }
      if (end === null) {
        end = nowMs - start <= ASSUMED_STAY_MS ? nowMs : start + ASSUMED_STAY_MS;
      }
      sessions.push({ customerId, start, end: Math.max(end, start), closed });
    }
  }
  return sessions;
}

// Average number of people present for each weekday x hour, over the window.
// `occurrences` is how many of that weekday fall in the window, so a busy
// Monday 6 pm is "about 14 people", not the eight-week total. Returns only the
// cells that were ever occupied, plus the busiest one.
export function heatFromSessions(sessions, { weeks, nowMs }) {
  const windowDays = weeks * 7;
  const todayKey = istParts(nowMs).dateKey;
  const occurrences = Array(7).fill(0);
  for (let i = 0; i < windowDays; i++) occurrences[istParts(nowMs - i * 24 * HOUR_MS).weekday] += 1;

  // minutes present per (calendar date, hour), then folded by weekday.
  const minutes = new Map();
  const arrivals = new Map();
  for (const s of sessions) {
    const a = istParts(s.start);
    arrivals.set(`${a.dateKey}|${a.hour}`, (arrivals.get(`${a.dateKey}|${a.hour}`) || 0) + 1);
    let cursor = s.start;
    while (cursor < s.end) {
      const p = istParts(cursor);
      const hourEnd = Math.floor((cursor + IST_OFFSET_MS) / HOUR_MS) * HOUR_MS + HOUR_MS - IST_OFFSET_MS;
      const sliceEnd = Math.min(hourEnd, s.end);
      const key = `${p.dateKey}|${p.hour}`;
      minutes.set(key, (minutes.get(key) || 0) + (sliceEnd - cursor) / 60000);
      cursor = sliceEnd;
    }
  }
  const sumPresent = new Map();
  const sumArrivals = new Map();
  for (const [key, mins] of minutes) {
    const [dateKey, hour] = key.split('|');
    const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
    const k = `${weekday}|${hour}`;
    sumPresent.set(k, (sumPresent.get(k) || 0) + mins / 60);
  }
  for (const [key, n] of arrivals) {
    const [dateKey, hour] = key.split('|');
    const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
    const k = `${weekday}|${hour}`;
    sumArrivals.set(k, (sumArrivals.get(k) || 0) + n);
  }
  const cells = [];
  for (const [k, total] of sumPresent) {
    const [weekday, hour] = k.split('|').map(Number);
    const n = Math.max(occurrences[weekday], 1);
    cells.push({
      weekday, hour,
      avgPresent: Math.round((total / n) * 10) / 10,
      avgArrivals: Math.round(((sumArrivals.get(k) || 0) / n) * 10) / 10,
    });
  }
  cells.sort((x, y) => x.weekday - y.weekday || x.hour - y.hour);
  const peak = cells.reduce((best, c) => (!best || c.avgPresent > best.avgPresent ? c : best), null);
  return { weeks, cells, peak, todayKey };
}
