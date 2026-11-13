// The Today card's running points: partial credit for work in progress and a
// mood row, layered on top of the engine without changing what it counted.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEffort, partialPoints, MOOD_ROW_POINTS } from '../services/plan/dayEffort.js';

const water = (over = {}) => ({
  kind: 'water', points: 5, earned: 0, done: false, progress: 0, ...over,
});
const food = (over = {}) => ({
  kind: 'food', points: 25, earned: 0, done: false, progress: 0, ...over,
});
const workout = (over = {}) => ({
  kind: 'workout', points: 15, earned: 0, done: false, progress: 0, ...over,
});
const resolve = (rows, extra = {}) => ({
  rows,
  earned: rows.reduce((n, r) => n + (r.earned ?? 0), 0),
  target: rows.reduce((n, r) => n + r.points, 0),
  nutritionTarget: { proteinG: 100, kcal: 2000 },
  totals: { proteinG: 0, kcal: 0, mealSlotsCovered: 0 },
  ...extra,
});
const rowOf = (out, kind) => out.rows.find((r) => r.kind === kind);

test('partialPoints: nothing is 0, anything is at least 1, never the full amount early', () => {
  assert.equal(partialPoints(5, 0), 0);
  assert.equal(partialPoints(5, 0.01), 1);
  assert.equal(partialPoints(5, 0.5), 3);
  assert.equal(partialPoints(5, 0.99), 4);
  assert.equal(partialPoints(5, 1), 5);
  assert.equal(partialPoints(5, 2), 5);
  assert.equal(partialPoints(0, 0.5), 0);
  assert.equal(partialPoints(5, NaN), 0);
});

test('a first glass of water moves the number', () => {
  const out = applyEffort(resolve([water({ progress: 0.1 })]));
  assert.equal(rowOf(out, 'water').credit, 1);
  assert.equal(out.effort.earned, 1);
});

test('water credit grows with progress and stays under the full 5 until done', () => {
  const credits = [0.2, 0.5, 0.9].map((p) => rowOf(applyEffort(resolve([water({ progress: p })])), 'water').credit);
  assert.deepEqual(credits, [1, 3, 4]);
});

test('a done row credits exactly what the engine paid, no more', () => {
  const out = applyEffort(resolve([water({ done: true, earned: 5, progress: 1 })]));
  assert.equal(rowOf(out, 'water').credit, 5);
  assert.equal(out.effort.earned, 5);
});

test('a late-done row stays at what the engine paid (0)', () => {
  const out = applyEffort(resolve([water({ done: true, earned: 0, progress: 1, late: true })]));
  assert.equal(rowOf(out, 'water').credit, 0);
});

test('a workout is binary: not done is 0', () => {
  const out = applyEffort(resolve([workout({ progress: 0 })]));
  assert.equal(rowOf(out, 'workout').credit, 0);
});

test('one breakfast logged earns food credit even though the engine pays 0', () => {
  const out = applyEffort(resolve([food()], {
    totals: { proteinG: 18, kcal: 420, mealSlotsCovered: 1 },
  }));
  const credit = rowOf(out, 'food').credit;
  assert.ok(credit > 0, 'logged food must show up');
  assert.ok(credit < 25, 'but not the whole row');
  assert.equal(out.effort.earned, credit);
});

test('food credit never goes below what the engine paid and never above the row', () => {
  const out = applyEffort(resolve([food({ earned: 25, done: true, progress: 1 })], {
    totals: { proteinG: 100, kcal: 2000, mealSlotsCovered: 3 },
  }));
  assert.equal(rowOf(out, 'food').credit, 25);
});

test('over-eating is not credited: calories far past target add nothing', () => {
  const base = { proteinG: 0, mealSlotsCovered: 0 };
  const at = (kcal) => rowOf(applyEffort(resolve([food()], { totals: { ...base, kcal } })), 'food').credit;
  assert.equal(at(3000), 0, '150% of target earns nothing');
  assert.ok(at(1000) > 0);
  assert.ok(at(2000) > at(1000), 'more, up to the target, earns more');
  assert.equal(at(2100), at(2000), 'the +10% band counts as on target');
  assert.ok(at(3000) < at(2000), 'past the band it falls away rather than growing');
});

test('three main meals reach the meals share in full', () => {
  const at = (n) => rowOf(applyEffort(resolve([food()], {
    totals: { proteinG: 0, kcal: 0, mealSlotsCovered: n },
  })), 'food').credit;
  assert.equal(at(0), 0);
  assert.equal(at(1), 2);
  assert.equal(at(2), 3);
  assert.equal(at(3), 5);
});

test('with no nutrition target food keeps the engine number', () => {
  const out = applyEffort(resolve([food({ earned: 0 })], { nutritionTarget: null, totals: null }));
  assert.equal(rowOf(out, 'food').credit, 0);
});

test('mood: no check-in is an empty row that is still on the card', () => {
  const out = applyEffort(resolve([water()]), []);
  const mood = rowOf(out, 'mood');
  assert.equal(out.rows[0].kind, 'mood', 'mood leads');
  assert.equal(mood.points, MOOD_ROW_POINTS);
  assert.equal(mood.credit, 0);
  assert.equal(mood.done, false);
  assert.equal(mood.action, 'log_mood');
  assert.equal(mood.mood, null);
});

test('mood: each check-in is worth half the row, two complete it', () => {
  const one = rowOf(applyEffort(resolve([]), [
    { slot: 'morning', mood: 'Calm', createdAt: new Date('2026-11-09T05:00:00Z') },
  ]), 'mood');
  assert.equal(one.credit, MOOD_ROW_POINTS / 2);
  assert.equal(one.done, false);
  assert.equal(one.progress, 0.5);
  assert.equal(one.mood, 'Calm');
  const two = rowOf(applyEffort(resolve([]), [
    { slot: 'morning', mood: 'Calm', createdAt: new Date('2026-11-09T05:00:00Z') },
    { slot: 'night', mood: 'Tired', createdAt: new Date('2026-11-09T14:00:00Z') },
  ]), 'mood');
  assert.equal(two.credit, MOOD_ROW_POINTS);
  assert.equal(two.done, true);
  assert.equal(two.mood, 'Tired', 'the latest check-in names the mood');
});

test('totals: target includes the mood row; engine numbers are not mutated', () => {
  const resolved = resolve([water({ progress: 0.5 }), workout()]);
  const before = JSON.stringify(resolved);
  const out = applyEffort(resolved, [{ slot: 'morning', mood: 'Good', createdAt: new Date() }]);
  assert.equal(JSON.stringify(resolved), before, 'input untouched');
  assert.equal(out.effort.target, resolved.target + MOOD_ROW_POINTS);
  assert.equal(out.effort.earned, 3 + 2);
});

test('every logging moves the total: water, food and mood each add something', () => {
  const none = applyEffort(resolve([water(), food()]), []).effort.earned;
  const w = applyEffort(resolve([water({ progress: 0.1 }), food()]), []).effort.earned;
  const f = applyEffort(
    resolve([water(), food()], { totals: { proteinG: 0, kcal: 300, mealSlotsCovered: 1 } }),
    [],
  ).effort.earned;
  const m = applyEffort(resolve([water(), food()]), [
    { slot: 'night', mood: 'Okay', createdAt: new Date() },
  ]).effort.earned;
  assert.equal(none, 0);
  for (const v of [w, f, m]) assert.ok(v > none);
});
