// Slot generation (utils/slots.js): plain time-slot splitting and the
// two-window (morning + evening) day shape gyms' operating hours row into.
// Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let generateTimeSlots, generateWindowedSlots;

test('setup: import slots', async () => {
  ({ generateTimeSlots, generateWindowedSlots } = await import('../utils/slots.js'));
});

test('generateTimeSlots: splits a window into non-overlapping slots', () => {
  assert.deepEqual(generateTimeSlots('06:00', '08:00', 60), [
    { startTime: '06:00', endTime: '07:00' },
    { startTime: '07:00', endTime: '08:00' },
  ]);
});

test('generateTimeSlots: honors a non-divisable window (floor, never overruns close)', () => {
  assert.deepEqual(generateTimeSlots('06:00', '08:01', 60), [
    { startTime: '06:00', endTime: '07:00' },
    { startTime: '07:00', endTime: '08:00' },
  ]);
});

test('generateTimeSlots: handles minute offsets with zero-padding', () => {
  assert.deepEqual(generateTimeSlots('08:05', '09:35', 90), [
    { startTime: '08:05', endTime: '09:35' },
  ]);
  assert.deepEqual(generateTimeSlots('08:45', '09:45', 30), [
    { startTime: '08:45', endTime: '09:15' },
    { startTime: '09:15', endTime: '09:45' },
  ]);
});

test('generateTimeSlots: returns [] when the window cannot fit any slot', () => {
  assert.deepEqual(generateTimeSlots('06:00', '06:00', 30), []);
  assert.deepEqual(generateTimeSlots('06:00', '06:29', 60), []);
  assert.deepEqual(generateTimeSlots('22:00', '00:00', 60), []); // close before open
});

test('generateTimeSlots: crosses hour boundaries cleanly', () => {
  assert.deepEqual(generateTimeSlots('23:30', '01:00', 60), []); // not supported past midnight
  assert.deepEqual(generateTimeSlots('10:30', '12:00', 45), [
    { startTime: '10:30', endTime: '11:15' },
    { startTime: '11:15', endTime: '12:00' },
  ]);
});

test('generateWindowedSlots: single morning window only', () => {
  const rows = [{ morningStart: '06:00', morningEnd: '08:00', eveningStart: null, eveningEnd: null }];
  assert.deepEqual(generateWindowedSlots(rows[0], 60), [
    { startTime: '06:00', endTime: '07:00' },
    { startTime: '07:00', endTime: '08:00' },
  ]);
});

test('generateWindowedSlots: both morning and evening windows combine', () => {
  const row = { morningStart: '06:00', morningEnd: '07:00', eveningStart: '18:00', eveningEnd: '19:00' };
  assert.deepEqual(generateWindowedSlots(row, 60), [
    { startTime: '06:00', endTime: '07:00' },
    { startTime: '18:00', endTime: '19:00' },
  ]);
});

test('generateWindowedSlots: a closed day (no windows) or null row yields []', () => {
  assert.deepEqual(generateWindowedSlots(null, 60), []);
  assert.deepEqual(generateWindowedSlots({}, 60), []);
  assert.deepEqual(generateWindowedSlots({ morningStart: '06:00', morningEnd: null }, 60), []);
  assert.deepEqual(generateWindowedSlots({ eveningStart: null, eveningEnd: '19:00' }, 60), []);
});

test('generateWindowedSlots: a midday gap splits the two windows', () => {
  const row = { morningStart: '06:00', morningEnd: '10:00', eveningStart: '16:00', eveningEnd: '20:00' };
  assert.deepEqual(generateWindowedSlots(row, 60), [
    { startTime: '06:00', endTime: '07:00' },
    { startTime: '07:00', endTime: '08:00' },
    { startTime: '08:00', endTime: '09:00' },
    { startTime: '09:00', endTime: '10:00' },
    { startTime: '16:00', endTime: '17:00' },
    { startTime: '17:00', endTime: '18:00' },
    { startTime: '18:00', endTime: '19:00' },
    { startTime: '19:00', endTime: '20:00' },
  ]);
});