// Slot-time gating (utils/slotTiming.js) — IST calendar handling, the 60-min
// minimum booking lead, weekday resolution, and today-in-IST. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let isSlotInPastOrTooSoon, getDayOfWeek, todayDateStringIST;

test('setup: import slotTiming', async () => {
  ({ isSlotInPastOrTooSoon, getDayOfWeek, todayDateStringIST } = await import('../utils/slotTiming.js'));
});

// Pinned "now": UTC 2026-09-14 10:00 == IST 15:30. Lead = 60 min -> cutover at UTC 11:00.
const NOW_UTC = Date.UTC(2026, 8, 14, 10, 0, 0);

test('isSlotInPastOrTooSoon: a slot more than an hour away is bookable', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(isSlotInPastOrTooSoon('2026-09-15', '06:00'), false);  // tomorrow IST
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '17:00'), false);  // 17:00 IST = 11:30Z (> lead)
});

test('isSlotInPastOrTooSoon: a slot under the lead is rejected', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '16:00'), true);   // UTC 10:30Z, 30 min away
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '15:30'), true);   // now
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '10:00'), true);   // 5.5h ago IST
});

test('isSlotInPastOrTooSoon: exactly at the 60-minute lead is allowed', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  assert.equal(isSlotInPastOrTooSoon('2026-09-14', '16:30'), false);  // UTC 11:00Z, exactly the lead
});

test('isSlotInPastOrTooSoon: midnight boundary treated as IST wall-clock, not UTC', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC });
  // 00:30 IST on Sep 15 -> UTC 19:00Z on Sep 14 — still future vs cutover, bookable.
  assert.equal(isSlotInPastOrTooSoon('2026-09-15', '00:30'), false);
});

test('getDayOfWeek: maps IST calendar dates to 0..6 (Sunday 0)', () => {
  assert.equal(getDayOfWeek('2026-09-13'), 0); // Sunday
  assert.equal(getDayOfWeek('2026-09-14'), 1); // Monday
  assert.equal(getDayOfWeek('2026-09-15'), 2); // Tuesday
  assert.equal(getDayOfWeek('2026-09-19'), 6); // Saturday
});

test('getDayOfWeek: is timezone-invariant (same date, any tz, same weekday)', () => {
  assert.equal(getDayOfWeek('2026-01-01'), 4); // Thursday
  assert.equal(getDayOfWeek('2026-02-29'), 0); // not a leap year -> falls to Mar 1? no: Feb 29 2026 normalizes to Mar 1 (Sunday)
});

test('todayDateStringIST: resolves "today" in IST even when UTC is a different date', (t) => {
  // UTC 2026-09-14 20:00 == IST 2026-09-15 01:30 -> today is the 15th.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 14, 20, 0, 0) });
  assert.equal(todayDateStringIST(), '2026-09-15');
});

test('todayDateStringIST: mid-afternoon UTC keeps the same IST calendar date', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_UTC }); // UTC 10:00 == IST 15:30 same day
  assert.equal(todayDateStringIST(), '2026-09-14');
});