// Covers the pure IST wall-clock math in utils/slotTiming.js — the booking
// lead-time gate (isSlotInPastOrTooSoon), class day-of-week check
// (getDayOfWeek), tiered-cancellation refund window (hoursUntilSlot), and the
// self-check-in active-window / early-scan logic (isSessionActiveNow,
// isBeforeSessionWindow, isSessionEnded, shiftedSlotForNow). No Prisma or
// network deps; every time-dependent assertion pins the clock with
// t.mock.timers so it's exact. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let todayDateStringIST, isSlotInPastOrTooSoon, getDayOfWeek, hoursUntilSlot,
  isSessionActiveNow, isBeforeSessionWindow, isSessionEnded, shiftedSlotForNow;

// Fixed "now": UTC 2026-09-14 10:00 == IST 2026-09-14 15:30.
const NOW_UTC = Date.UTC(2026, 8, 14, 10, 0, 0);

test('setup: import slotTiming once', async (t) => {
  ({ todayDateStringIST, isSlotInPastOrTooSoon, getDayOfWeek, hoursUntilSlot,
     isSessionActiveNow, isBeforeSessionWindow, isSessionEnded, shiftedSlotForNow }
    = await import('../utils/slotTiming.js'));
  assert.equal(typeof todayDateStringIST, 'function');
});

// Weekday references are fixed IST calendar dates — India has no DST, so
// getDayOfWeek is a pure function of the date string (0=Sunday..6=Saturday).
test('getDayOfWeek: fixed IST calendar-date references', () => {
  assert.equal(getDayOfWeek('2026-01-01'), 4);  // Thursday
  assert.equal(getDayOfWeek('2026-03-01'), 0);  // Sunday
  assert.equal(getDayOfWeek('2026-09-14'), 1);  // Monday
  assert.equal(getDayOfWeek('2026-09-15'), 2);  // Tuesday
  assert.equal(getDayOfWeek('2026-12-25'), 5);  // Friday
});

test('todayDateStringIST: exact IST calendar date under a pinned clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(todayDateStringIST(), '2026-09-14');
});

test('todayDateStringIST: returns a plain YYYY-MM-DD string on a real clock', () => {
  const s = todayDateStringIST();
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
});

test('isSlotInPastOrTooSoon: far-past is not bookable, far-future is', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(isSlotInPastOrTooSoon('2000-01-01', '10:00'), true);
  assert.equal(isSlotInPastOrTooSoon('2099-01-01', '10:00'), false);
});

test('isSlotInPastOrTooSoon: 60-minute minimum lead applies on the minute', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  // IST 16:29 = UTC 10:59 — 59m away, inside the 1h lead → not bookable.
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '16:29'), true);
  // IST 16:30 = UTC 11:00 — exactly 1h away → just bookable.
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '16:30'), false);
  // IST 16:31 = UTC 11:01 — over the lead → bookable.
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '16:31'), false);
});

test('hoursUntilSlot: positive into the future, negative into the past', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const future = hoursUntilSlot('2026-09-15', '10:00'); // UTC 09-15 04:30 − now = 18.5h
  assert.equal(future, 18.5);
  assert.ok(hoursUntilSlot('2026-09-13', '10:00') < 0);
});

test('isSessionActiveNow: inside the window and inside the 15m early grace both count as active', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  // IST 15:00–16:00, now 15:30 → inside.
  assert.equal(isSessionActiveNow('2026-09-14', '15:00', '16:00'), true);
  // IST 15:40 start — now 15:30 is 10m early, within the grace → active.
  assert.equal(isSessionActiveNow('2026-09-14', '15:40', '16:40'), true);
  // IST 16:00 start — now is 30m early, past the grace → not yet active.
  assert.equal(isSessionActiveNow('2026-09-14', '16:00', '17:00'), false);
  // IST 15:00–15:15 — session already ended.
  assert.equal(isSessionActiveNow('2026-09-14', '15:00', '15:15'), false);
});

test('isBeforeSessionWindow: true only when more than 15m before start (shift-worthy early scan)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(isBeforeSessionWindow('2026-09-14', '16:00'), true);   // 30m early
  assert.equal(isBeforeSessionWindow('2026-09-14', '15:40'), false);  // 10m early, within grace
  assert.equal(isBeforeSessionWindow('2026-09-14', '15:00'), false);  // already started
});

test('isSessionEnded: after end-time only', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(isSessionEnded('2026-09-14', '15:10'), true);   // IST 15:10 → UTC 09:40, past
  assert.equal(isSessionEnded('2026-09-14', '16:00'), false);  // still running
});

test('shiftedSlotForNow: anchors to the current IST wall-clock, preserves duration', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  const oneHour = shiftedSlotForNow('2026-09-14', '15:00', '16:00');
  assert.equal(oneHour.newStartTime, '15:30');   // now in IST
  assert.equal(oneHour.newEndTime, '16:30');     // start + 60m
  assert.equal(minutesBetween(oneHour.newStartTime, oneHour.newEndTime), 60);

  const fortyFive = shiftedSlotForNow('2026-09-14', '23:00', '23:45');
  assert.equal(fortyFive.newStartTime, '15:30');
  assert.equal(fortyFive.newEndTime, '16:15');
  assert.equal(minutesBetween(fortyFive.newStartTime, fortyFive.newEndTime), 45);
});

function minutesBetween(start, end) {
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  return (toMin(end) - toMin(start) + 1440) % 1440;
}