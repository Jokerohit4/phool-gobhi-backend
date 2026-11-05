import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatedOneRepMaxKg, pickBestRecord, topRecords } from '../utils/records.js';

const r = (weight, reps, unit = 'kg', name = 'Lift') => ({ weight, reps, unit, exerciseName: name });
const near = (a, b) => Math.abs(a - b) < 0.01;

test('estimated one-rep max: one rep is a little over the weight, five reps more', () => {
  assert.ok(near(estimatedOneRepMaxKg(r(100, 1)), 103.33));
  assert.ok(near(estimatedOneRepMaxKg(r(100, 5)), 116.67));
});

test('pounds convert so units compare fairly', () => {
  const lb = estimatedOneRepMaxKg(r(225, 1, 'lb')); // about 102 kg
  assert.ok(lb < estimatedOneRepMaxKg(r(105, 1)));
  assert.ok(lb > estimatedOneRepMaxKg(r(100, 1)));
});

test('a huge rep count cannot inflate the estimate', () => {
  assert.equal(estimatedOneRepMaxKg(r(20, 1000)), estimatedOneRepMaxKg(r(20, 30)));
});

test('the best is the strongest, not the newest or the first listed', () => {
  const best = pickBestRecord([r(40, 10, 'kg', 'Curl'), r(140, 3, 'kg', 'Squat'), r(100, 5, 'kg', 'Bench')]);
  assert.equal(best.exerciseName, 'Squat');
});

test('a tie goes to the first (the newest, when passed newest-first)', () => {
  assert.equal(pickBestRecord([r(100, 5, 'kg', 'A'), r(100, 5, 'kg', 'B')]).exerciseName, 'A');
});

test('nothing in, nothing out', () => {
  assert.equal(pickBestRecord([]), null);
});

test('topRecords: the n strongest, best first, ties in the order given', () => {
  const records = [r(40, 10, 'kg', 'Curl'), r(140, 3, 'kg', 'Squat'), r(100, 5, 'kg', 'Bench'), r(100, 5, 'kg', 'Bench2')];
  assert.deepEqual(topRecords(records, 3).map((x) => x.exerciseName), ['Squat', 'Bench', 'Bench2']);
  assert.equal(topRecords(records, 1)[0].exerciseName, 'Squat');
  assert.deepEqual(topRecords([], 3), []);
  assert.equal(topRecords(records, 10).length, 4);
});
