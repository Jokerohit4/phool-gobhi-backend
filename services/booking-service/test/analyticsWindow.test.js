import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isToday, todayWindowDays } from '../utils/analyticsWindow.js';
import { trafficFilters, buildTrafficQuery } from '../services/trafficReport.js';

// 2026-11-18T12:00:00Z is 17:30 IST, so 17.5h have elapsed since IST midnight.
const NOON_UTC = new Date('2026-11-18T12:00:00Z');

test('isToday only matches the literal "today"', () => {
  assert.equal(isToday('today'), true);
  assert.equal(isToday(' Today '), true);
  assert.equal(isToday('7'), false);
  assert.equal(isToday(7), false);
  assert.equal(isToday(undefined), false);
});

test('todayWindowDays is the fraction of a day since IST midnight', () => {
  assert.ok(Math.abs(todayWindowDays(NOON_UTC) - 17.5 / 24) < 1e-9);
  // 18:30Z is 00:00 IST the next day: just past midnight, floor applies (never zero).
  assert.equal(todayWindowDays(new Date('2026-11-18T18:30:00Z')), 1 / 48);
  // 18:29Z is 23:59 IST: nearly a full day.
  assert.ok(todayWindowDays(new Date('2026-11-18T18:29:00Z')) > 0.99);
});

test('traffic filters accept today as a fractional window and still reject junk', () => {
  const f = trafficFilters({ days: 'today' }, NOON_UTC);
  assert.ok(Math.abs(f.days - 17.5 / 24) < 1e-9);
  assert.equal(trafficFilters({}, NOON_UTC).days, 30);
  assert.equal(trafficFilters({ days: 7 }, NOON_UTC).days, 7);
  assert.throws(() => trafficFilters({ days: 'yesterday' }, NOON_UTC), { status: 400 });
  assert.throws(() => trafficFilters({ days: 1.5 }, NOON_UTC), { status: 400 });
});

test('the traffic query window starts at IST midnight for today', () => {
  const q = buildTrafficQuery({ days: 'today' }, { asOf: NOON_UTC });
  // values[2] is the current-window start: 2026-11-17T18:30:00Z = 00:00 IST on the 18th.
  assert.equal(q.values[2], '2026-11-17T18:30:00.000Z');
  assert.equal(q.values[1], NOON_UTC.toISOString());
});
