// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoIsInside, hourlyFlow, sessionsFromEvents, heatFromSessions, istParts, MAX_STAY_MS, ASSUMED_STAY_MS } from '../utils/presenceMath.js';

// 2026-11-09 is a Monday. 18:00 IST = 12:30 UTC.
const at = (h, m = 0) => Date.UTC(2026, 10, 9, h, m) - 5.5 * 3600000;
const ev = (customerId, kind, ms, extra = {}) => ({ customerId, kind, at: new Date(ms), source: 'member', ...extra });

test('istParts reads IST wall-clock fields', () => {
  assert.deepEqual(istParts(at(18)), { dateKey: '2026-11-09', weekday: 1, hour: 18 });
  // 00:30 IST on the 10th is still the 9th in UTC.
  assert.deepEqual(istParts(at(24, 30)), { dateKey: '2026-11-10', weekday: 2, hour: 0 });
});

test('whoIsInside: last event decides, a departure removes the person', () => {
  const events = [ev(1, 'in', at(17)), ev(2, 'in', at(17, 5)), ev(1, 'out', at(17, 50)), ev(3, 'in', at(17, 30), { source: 'booking', bookingId: 9 })];
  const inside = whoIsInside(events, at(18));
  assert.deepEqual([...inside.keys()].sort(), [2, 3]);
  assert.equal(inside.get(3).source, 'booking');
  assert.equal(inside.get(3).bookingId, 9);
});

test('whoIsInside: events out of order are sorted, and a re-entry counts', () => {
  const events = [ev(1, 'in', at(18)), ev(1, 'out', at(17)), ev(1, 'in', at(16))];
  assert.equal(whoIsInside(events, at(18, 5)).has(1), true);
});

test('whoIsInside: an arrival nobody closed expires after the maximum stay', () => {
  const events = [ev(1, 'in', at(10))];
  assert.equal(whoIsInside(events, at(10) + MAX_STAY_MS - 1).has(1), true);
  assert.equal(whoIsInside(events, at(10) + MAX_STAY_MS + 1).has(1), false);
});

test('hourlyFlow counts arrivals and departures in the IST hour, for one day only', () => {
  const events = [ev(1, 'in', at(17, 59)), ev(2, 'in', at(18)), ev(1, 'out', at(18, 40)), ev(3, 'in', at(18) + 86400000)];
  const h = hourlyFlow(events, '2026-11-09');
  assert.equal(h[17].arrivals, 1);
  assert.equal(h[18].arrivals, 1);
  assert.equal(h[18].departures, 1);
  assert.equal(h.reduce((n, x) => n + x.arrivals, 0), 2);
});

test('sessionsFromEvents pairs in with out; an open stay runs to now, then to the assumed length', () => {
  const closed = sessionsFromEvents([ev(1, 'in', at(17)), ev(1, 'out', at(18))], at(20));
  assert.equal(closed[0].end - closed[0].start, 3600000);
  assert.equal(closed[0].closed, true);
  const stillIn = sessionsFromEvents([ev(1, 'in', at(17))], at(17, 20));
  assert.equal(stillIn[0].end, at(17, 20));
  const forgot = sessionsFromEvents([ev(1, 'in', at(17))], at(23));
  assert.equal(forgot[0].end - forgot[0].start, ASSUMED_STAY_MS);
});

test('sessionsFromEvents: a second arrival ends an unrecorded first stay', () => {
  const s = sessionsFromEvents([ev(1, 'in', at(10)), ev(1, 'in', at(10, 30))], at(23));
  assert.equal(s.length, 2);
  assert.equal(s[0].end, at(10, 30));
});

test('heatFromSessions averages over how many of that weekday are in the window', () => {
  // One person, 18:00-19:00 on this Monday, over a 4-week window: 4 Mondays -> 0.25 present.
  const sessions = sessionsFromEvents([ev(1, 'in', at(18)), ev(1, 'out', at(19))], at(20));
  const heat = heatFromSessions(sessions, { weeks: 4, nowMs: at(20) });
  const cell = heat.cells.find((c) => c.weekday === 1 && c.hour === 18);
  assert.equal(cell.avgPresent, 0.3); // 1/4 = 0.25, rounded to one place
  assert.equal(heat.peak.hour, 18);
});

test('heatFromSessions splits a stay across hours by the minutes in each', () => {
  const sessions = sessionsFromEvents([ev(1, 'in', at(17, 30)), ev(1, 'out', at(18, 30))], at(20));
  const heat = heatFromSessions(sessions, { weeks: 1, nowMs: at(20) });
  const h17 = heat.cells.find((c) => c.hour === 17);
  const h18 = heat.cells.find((c) => c.hour === 18);
  assert.equal(h17.avgPresent, 0.5);
  assert.equal(h18.avgPresent, 0.5);
});
