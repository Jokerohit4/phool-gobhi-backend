import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDay,
  isScheduledFor,
  checkForLowIntakeRun,
  computeMisses,
  computeEarns,
} from '../services/ledger/scoreEngine.js';
import { DAILY_MAX_GAIN, DAILY_MAX_LOSS, POINTS, SAFETY } from '../services/ledger/constants.js';

const TARGETS = {
  kcal: 2500,
  proteinG: 133,
  carbsG: 300,
  fatG: 78,
  fibreG: 35,
  waterMl: 2950,
  micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
};

// New plan items without nutrition (food is synthesised)
const PLAN_ITEMS = [
  { id: 'w1', kind: 'workout', schedule: '1,3,5', active: true, title: 'Workout', layerKey: 'workout' },
  { id: 'h1', kind: 'habit', schedule: 'daily', active: true, title: 'Sleep 7 h', layerKey: 'sleep' },
  { id: 'r1', kind: 'rest', schedule: '7', active: true, title: 'Rest day', layerKey: 'workout' },
  { id: 'd1', kind: 'doctor_medication', schedule: 'daily', active: true, title: 'As advised', layerKey: 'medicine' },
];

// A Tuesday, ISO weekday 2.
const TUE = '2026-09-29';
// A Wednesday, ISO weekday 3. The workout item is scheduled '1,3,5', so a
// Tuesday is NOT a day it is due.
const WED = '2026-09-30';
// A Sunday, ISO weekday 7 — the rest day.
const SUN = '2026-10-04';

const ON_TARGET = {
  kcal: 2500,
  proteinG: 133,
  fatG: 78,
  waterMl: 2950,
  micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
  hasAnyFood: true,
  mealSlotsCovered: 3,
};

// --- The eating-disorder guard --------------------------------------------

test('undereating and overeating are scored identically', () => {
  const low = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 800 },
    targets: TARGETS,
    closed: true,
    unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
  });
  const high = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 4200 },
    targets: TARGETS,
    closed: true,
    unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
  });

  const lowCal = low.breakdown.find((l) => l.key === 'calories_off_target');
  const highCal = high.breakdown.find((l) => l.key === 'calories_off_target');

  assert.ok(lowCal, 'low cal miss should exist');
  assert.ok(highCal, 'high cal miss should exist');
  assert.equal(lowCal.points, highCal.points);
  assert.equal(lowCal.points, POINTS.caloriesOffTarget);
  assert.ok(lowCal.points < 0, 'undereating must never earn points');
  assert.equal(lowCal.direction, 'low');
  assert.equal(highCal.direction, 'high');
});

test('a day of severe undereating cannot fall further than the daily loss cap', () => {
  let close = 500;
  for (let i = 0; i < 7; i += 1) {
    const day = computeDay({
      localDate: `2026-09-${String(20 + i).padStart(2, '0')}`,
      planItems: PLAN_ITEMS,
      totals: { ...ON_TARGET, kcal: 200, proteinG: 0, waterMl: 0, hasAnyFood: false, mealSlotsCovered: 0 },
      targets: TARGETS,
      previousClose: close,
      closed: true,
      unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
    });
    assert.ok(
      day.low >= close - DAILY_MAX_LOSS,
      `day ${i}: fell ${close - day.low}, cap is ${DAILY_MAX_LOSS}`,
    );
    close = day.close;
  }
  assert.ok(close > 0, `a bad week zeroed the score (close ${close})`);
});

test('five low days raise a check-in, not a red candle', () => {
  const snapshots = Array.from({ length: 5 }, (_, i) => {
    const date = `2026-09-${String(20 + i).padStart(2, '0')}`;
    const day = computeDay({
      localDate: date,
      planItems: PLAN_ITEMS,
      totals: { ...ON_TARGET, kcal: 700 },
      targets: TARGETS,
      closed: true,
      unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
    });
    return { localDate: date, close: day.close, breakdown: day.breakdown };
  });

  const run = checkForLowIntakeRun(snapshots);
  assert.ok(run, 'expected a low-intake run to be detected');
  assert.equal(run.kind, 'check_in');
  assert.equal(run.days, 5);
  assert.equal(run.points, 0);
  assert.equal(run.isMiss, false);
  assert.ok(
    !/fail|lose|bad|missed|wrong|starv/i.test(run.message),
    `tone is wrong: "${run.message}"`,
  );
  assert.equal(run.action, 'review_targets');
});

test('the check-in is not affected by the wording of the label', () => {
  const snapshots = Array.from({ length: 5 }, (_, i) => ({
    localDate: `2026-09-${20 + i}`,
    close: 100,
    breakdown: [
      {
        key: 'calories_off_target',
        label: 'بائی کیلوری کم ہیں',
        points: -8,
        direction: 'low',
      },
    ],
  }));

  assert.ok(checkForLowIntakeRun(snapshots), 'guard must not depend on label text');
});

test('four low days do not trigger the check-in', () => {
  const snapshots = Array.from({ length: 4 }, (_, i) => {
    const day = computeDay({
      localDate: `2026-09-${20 + i}`,
      planItems: PLAN_ITEMS,
      totals: { ...ON_TARGET, kcal: 700 },
      targets: TARGETS,
      closed: true,
      unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
    });
    return { localDate: `2026-09-${20 + i}`, close: day.close, breakdown: day.breakdown };
  });
  assert.equal(checkForLowIntakeRun(snapshots), null);
});

test('a high-intake streak is NOT treated as a low-intake run', () => {
  const snapshots = Array.from({ length: 6 }, (_, i) => {
    const day = computeDay({
      localDate: `2026-09-${20 + i}`,
      planItems: PLAN_ITEMS,
      totals: { ...ON_TARGET, kcal: 5000 },
      targets: TARGETS,
      closed: true,
      unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
    });
    return { localDate: `2026-09-${20 + i}`, close: day.close, breakdown: day.breakdown };
  });
  assert.equal(checkForLowIntakeRun(snapshots), null);
});

test('the guard is off by default below its threshold and has one threshold', () => {
  const day = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 700 },
    targets: TARGETS,
    closed: true,
    unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
  });
  const atThreshold = Array.from({ length: SAFETY.lowIntakeRunDays }, () => ({
    close: 100,
    breakdown: day.breakdown,
  }));
  const justUnder = Array.from({ length: SAFETY.lowIntakeRunDays - 1 }, () => ({
    close: 100,
    breakdown: day.breakdown,
  }));
  assert.ok(checkForLowIntakeRun(atThreshold));
  assert.equal(checkForLowIntakeRun(justUnder), null);
});

// --- Candle mechanics ------------------------------------------------------

test('a perfect day and an empty day differ, and both are finite', () => {
  const perfect = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: ON_TARGET,
    targets: TARGETS,
    closed: true,
    unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
    completions: [
      { planItemId: 'w1' },
      { planItemId: 'h1' },
      { planItemId: 'd1' },
    ],
  });
  const empty = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 0, proteinG: 0, waterMl: 0, hasAnyFood: false, mealSlotsCovered: 0 },
    targets: TARGETS,
    closed: true,
    unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
  });

  assert.ok(perfect.close > empty.close);
  assert.ok(Number.isFinite(perfect.close) && Number.isFinite(empty.close));
  assert.equal(perfect.open, 0);
});

test('one huge day cannot out-earn a run of good days', () => {
  let close = 0;
  for (let i = 0; i < 10; i += 1) {
    close = computeDay({
      localDate: `2026-10-${String(i + 1).padStart(2, '0')}`,
      planItems: PLAN_ITEMS,
      totals: ON_TARGET,
      targets: TARGETS,
      previousClose: close,
      closed: true,
      unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
      completions: [{ planItemId: 'w1' }, { planItemId: 'h1' }, { planItemId: 'd1' }],
    }).close;
  }
  const averageGain = close / 10;
  assert.ok(
    averageGain <= DAILY_MAX_GAIN,
    `average daily gain ${averageGain.toFixed(1)} exceeds the cap ${DAILY_MAX_GAIN}`,
  );
});

test('the close is an integer, so the chart has no fractional pixels', () => {
  const day = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: ON_TARGET,
    targets: TARGETS,
    previousClose: 137,
    closed: true,
    unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
    completions: [{ planItemId: 'h1' }],
  });
  assert.equal(Number.isInteger(day.close), true, `close was ${day.close}`);
  assert.equal(day.open, 137);
});

test('an open day carries no misses, so the candle can still move up', () => {
  const day = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 1000 },
    targets: TARGETS,
    previousClose: 200,
    closed: false,
    unlockedLayerKeys: ['workout', 'sleep', 'medicine'],
  });
  assert.equal(day.breakdown.some((l) => l.points < 0), false);
  assert.ok(day.close >= day.open);
});

test('the snapshot records which rules version produced it', () => {
  const day = computeDay({ localDate: TUE, planItems: PLAN_ITEMS, totals: {}, targets: TARGETS, closed: true, unlockedLayerKeys: [] });
  assert.match(day.rulesVersion, /^v\d+$/);
});

// --- Scheduling ------------------------------------------------------------

test('a day-of-week schedule fires on exactly its own days', () => {
  const dates = [
    ['2026-09-28', 1], // Mon
    ['2026-09-29', 2],
    ['2026-10-01', 4], // Thu
    ['2026-10-02', 5], // Fri
    ['2026-10-04', 7], // Sun
  ];
  const item = { schedule: '1,3,5', active: true };
  for (const [date, iso] of dates) {
    assert.equal(
      isScheduledFor(item, date),
      [1, 3, 5].includes(iso),
      `${date} (ISO ${iso})`,
    );
  }
});

test('daily, one-off and weekly schedules all resolve', () => {
  assert.equal(isScheduledFor({ schedule: 'daily', active: true }, TUE), true);
  assert.equal(isScheduledFor({ schedule: TUE, active: true }, TUE), true);
  assert.equal(isScheduledFor({ schedule: '2026-10-01', active: true }, TUE), false);
  assert.equal(isScheduledFor({ schedule: 'weekly', active: true }, TUE), true);
});

test('a single-day schedule fires on that day only', () => {
  const sundayOnly = { schedule: '7', active: true };
  assert.equal(isScheduledFor(sundayOnly, SUN), true);
  assert.equal(isScheduledFor(sundayOnly, TUE), false);
  assert.equal(isScheduledFor(sundayOnly, '2026-10-03'), false);

  const mondayOnly = { schedule: '1', active: true };
  assert.equal(isScheduledFor(mondayOnly, '2026-09-28'), true);
  assert.equal(isScheduledFor(mondayOnly, '2026-09-29'), false);
});

test('the weekday helper is timezone-proof', () => {
  const mon = { schedule: '1', active: true };
  assert.equal(isScheduledFor(mon, '2026-09-28'), true);
  assert.equal(isScheduledFor(mon, '2026-09-29'), false);
  assert.equal(isScheduledFor(mon, '2027-01-04'), true);
  assert.equal(isScheduledFor(mon, '2028-02-29'), false);
});

test('an item whose course has ended stops counting but is not deleted', () => {
  const item = { schedule: 'daily', active: true, endsOn: '2026-09-28' };
  assert.equal(isScheduledFor(item, '2026-09-28'), true);
  assert.equal(isScheduledFor(item, '2026-09-29'), false);
  assert.ok(item.endsOn, 'the end date is still on the item');
});

test('an inactive item is never scheduled', () => {
  assert.equal(isScheduledFor({ schedule: 'daily', active: false }, TUE), false);
});

// --- Item-level scoring ---------------------------------------------------

test('a completed doctor item earns its points, and never auto-completes', () => {
  const item = PLAN_ITEMS.find((i) => i.kind === 'doctor_medication');

  const done = computeEarns({
    planItems: [item],
    completions: [{ planItemId: 'd1' }],
    targets: null,
    totals: null,
    localDate: TUE,
  });
  assert.equal(done[0].points, POINTS.doctorItemDone);
  assert.ok(done[0].points > 0);

  const notDone = computeEarns({
    planItems: [item],
    completions: [],
    targets: null,
    totals: null,
    localDate: TUE,
  });
  assert.equal(notDone.length, 0, 'a doctor item must never be auto-satisfied');
});

test('a late completion records the event but earns nothing', () => {
  const item = PLAN_ITEMS.find((i) => i.kind === 'habit');
  const r = computeEarns({
    planItems: [item],
    completions: [{ planItemId: 'h1', late: true }],
    targets: null,
    totals: null,
    localDate: TUE,
  });
  assert.equal(r[0].points, 0);
  assert.equal(r[0].late, true);
});

test('no auto completion rows are written', () => {
  // Auto completions are not written to DB; computeEarns no longer checks how='auto'
  // This test documents the new behavior
  const r = computeEarns({
    planItems: PLAN_ITEMS.filter((i) => i.kind === 'habit'),
    completions: [{ planItemId: 'h1' }], // no how field
    targets: null,
    totals: null,
    localDate: TUE,
  });
  assert.equal(r.length, 1, 'habit completion is paid without how check');
});

// --- Rest day honoured in earns (not misses) ---

test('a rest day is honoured automatically in earns, not charged as a miss', () => {
  // Rest day now earns +5 in computeEarns, not in computeMisses
  const restItem = PLAN_ITEMS.find((i) => i.kind === 'rest');
  
  const earns = computeEarns({
    planItems: [restItem],
    completions: [],
    targets: null,
    totals: ON_TARGET,
    localDate: SUN,
  });
  const honoured = earns.find((l) => l.key === 'rest_day_honoured');
  assert.ok(honoured, 'expected the rest day to be honoured in earns');
  assert.equal(honoured.points, POINTS.restDayHonoured);
  assert.ok(honoured.points > 0);

  // Misses should NOT include rest_day_honoured
  const misses = computeMisses({
    planItems: [restItem],
    completions: [],
    targets: null,
    totals: ON_TARGET,
    localDate: SUN,
    noMisses: false,
    unlockedLayerKeys: ['workout'],
    foodNoPenalty: false,
  });
  const missHonoured = misses.find((l) => l.key === 'rest_day_honoured');
  assert.equal(missHonoured, undefined, 'rest_day_honoured should not be in misses');
});

test('a workout is not charged on a day it was not scheduled', () => {
  const r = computeMisses({
    planItems: [PLAN_ITEMS.find((i) => i.kind === 'workout')],
    completions: [],
    targets: TARGETS,
    totals: ON_TARGET,
    localDate: TUE, // ISO 2, not in 1,3,5
    noMisses: false,
    unlockedLayerKeys: ['workout'],
    foodNoPenalty: false,
  });
  assert.equal(
    r.some((l) => l.key === 'workout_missed'),
    false,
    'Tuesday is not a 1,3,5 day and must not be charged',
  );
});

test('a workout IS charged on a day it was scheduled and missed', () => {
  const r = computeMisses({
    planItems: [PLAN_ITEMS.find((i) => i.kind === 'workout')],
    completions: [],
    targets: null,
    totals: null,
    localDate: '2026-09-30', // Wednesday, ISO 3 — inside 1,3,5
    noMisses: false,
    unlockedLayerKeys: ['workout'],
    foodNoPenalty: false,
  });
  const miss = r.find((l) => l.key === 'workout_missed');
  assert.ok(miss, 'expected a missed workout on a scheduled day');
  assert.equal(miss.points, POINTS.plannedWorkoutMissed);
  assert.ok(miss.points < 0);
});

// --- planned vs unplanned workouts (engine level) ---------------------------

test('an extra workout is paid when the plan had no workout done', () => {
  const r = computeEarns({
    planItems: [],
    completions: [],
    targets: null,
    totals: null,
    localDate: TUE,
    hasPlannedWorkout: false,
    hasPlannedWorkoutDone: false,
    unplannedWorkout: true,
  });
  const extra = r.find((l) => l.key === 'workout_unplanned');
  assert.ok(extra, 'a session on a day with no planned workout is extra');
  assert.equal(extra.points, POINTS.unplannedWorkout);
});

test('an extra workout is NOT paid on top of a completed planned one', () => {
  const workout = PLAN_ITEMS.find((i) => i.kind === 'workout');
  const r = computeEarns({
    planItems: [workout],
    completions: [{ planItemId: workout.id }],
    targets: null,
    totals: null,
    localDate: WED,
    hasPlannedWorkout: true,
    hasPlannedWorkoutDone: true,
    unplannedWorkout: true,
  });
  const workoutLines = r.filter((l) => l.kind === 'workout');
  assert.equal(workoutLines.length, 1, 'exactly one workout line, never two');
  assert.equal(workoutLines[0].key, `item_done_${workout.id}`);
  assert.equal(r.find((l) => l.key === 'workout_unplanned'), undefined);
});

test('an extra workout is paid when a workout was scheduled but never completed', () => {
  const workout = PLAN_ITEMS.find((i) => i.kind === 'workout');
  const r = computeEarns({
    planItems: [workout],
    completions: [],
    targets: null,
    totals: null,
    localDate: WED,
    hasPlannedWorkout: true,
    hasPlannedWorkoutDone: false,
    unplannedWorkout: true,
  });
  assert.ok(r.find((l) => l.key === 'workout_unplanned'));
  assert.equal(r.find((l) => l.key === `item_done_${workout.id}`), undefined);
});

test('the extra workout rate stays below the planned rate', () => {
  assert.ok(POINTS.unplannedWorkout < POINTS.plannedWorkoutDone);
});

// --- Pause ------------------------------------------------------------------

const PAUSED = { paused: true };
const FULL_PLAN = [
  { id: 1, kind: 'workout', title: 'Leg day', schedule: 'daily', active: true, endsOn: null, completions: [] },
  { id: 2, kind: 'habit', title: '8k steps', schedule: 'daily', active: true, endsOn: null, completions: [] },
];
const NO_TARGETS = null;

test('a paused day earns nothing even with a plan and nothing done', () => {
  const day = computeDay({
    localDate: '2026-09-29',
    previousClose: 120,
    planItems: FULL_PLAN,
    completions: [],
    targets: NO_TARGETS,
    totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, waterMl: 0 },
    closed: true,
    ...PAUSED,
  });
  assert.equal(day.grossGain, 0);
  assert.equal(day.grossLoss, 0);
});

test('a paused day is not a day worth zero - it has no breakdown at all', () => {
  const day = computeDay({
    localDate: '2026-09-29',
    previousClose: 120,
    planItems: FULL_PLAN,
    completions: [],
    targets: NO_TARGETS,
    totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, waterMl: 0 },
    closed: true,
    ...PAUSED,
  });
  assert.deepEqual(day.breakdown, []);
  assert.equal(day.paused, true);
});

test('a paused day passes the chain through unchanged', () => {
  const day = computeDay({
    localDate: '2026-09-29',
    previousClose: 314,
    closed: true,
    ...PAUSED,
  });
  assert.equal(day.open, 314);
  assert.equal(day.high, 314);
  assert.equal(day.low, 314);
  assert.equal(day.close, 314);
});

test('a paused day ignores the caps rather than being clamped by them', () => {
  const day = computeDay({ localDate: '2026-09-29', previousClose: 0, closed: true, ...PAUSED });
  assert.equal(day.capped, false);
});

test('a day that is not paused says so, rather than leaving it undefined', () => {
  const day = computeDay({
    localDate: '2026-09-29',
    previousClose: 0,
    planItems: [],
    completions: [],
    targets: NO_TARGETS,
    totals: null,
    closed: true,
  });
  assert.equal(day.paused, false);
});

test('the day after a pause resumes from the paused day close', () => {
  const paused = computeDay({ localDate: '2026-09-30', previousClose: 500, closed: true, ...PAUSED });
  const resumed = computeDay({
    localDate: '2026-10-01',
    previousClose: paused.close,
    planItems: [FULL_PLAN[0]],
    completions: [{ planItemId: 1 }],
    targets: NO_TARGETS,
    totals: null,
    closed: true,
    hasPlannedWorkout: true,
    hasPlannedWorkoutDone: true,
  });
  assert.equal(resumed.open, 500);
  assert.ok(resumed.close > 500, 'the resumed day should earn from the paused close');
  assert.equal(resumed.paused, false);
});

// --- B10: fair score (locked layers, easy start, inactive pause) ------------

const B10_TODAY = '2026-10-20';

const B10_PLAN_ITEMS = [
  { id: 'w1', kind: 'workout', schedule: 'daily', active: true, title: 'Workout', layerKey: 'workout' },
  { id: 'h1', kind: 'habit', schedule: 'daily', active: true, title: 'Water 2.5L', layerKey: 'water' },
  { id: 's1', kind: 'habit', schedule: 'daily', active: true, title: 'Steps 8k', layerKey: 'steps' },
  { id: 'sl1', kind: 'habit', schedule: 'daily', active: true, title: 'Sleep 7h', layerKey: 'sleep' },
  { id: 'supp1', kind: 'habit', schedule: 'daily', active: true, title: 'Supplements', layerKey: 'supplements' },
  { id: 'h2', kind: 'habit', schedule: 'daily', active: true, title: 'Health check', layerKey: 'health' },
  { id: 'm1', kind: 'doctor_medication', schedule: 'daily', active: true, title: 'Medication', layerKey: 'medicine' },
];

const B10_TARGETS = {
  kcal: 2500,
  proteinG: 130,
  waterMl: 2500,
  micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
};

const B10_ON_TARGET = {
  kcal: 2500,
  proteinG: 130,
  waterMl: 2500,
  micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
  hasAnyFood: true,
};

test('locked layer items produce no miss lines (fair scoring)', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: B10_TARGETS,
    totals: { ...B10_ON_TARGET, kcal: 1000, proteinG: 20, waterMl: 500, hasAnyFood: true },
    closed: true,
    unlockedLayerKeys: ['workout', 'water'], // layer 1 only
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(missKeys.includes('workout_missed'));
  assert.ok(missKeys.some((k) => k.startsWith('habit_missed')), 'water miss expected');
  assert.ok(!missKeys.includes('protein_short'), 'food layer locked: no protein miss');
  assert.ok(!missKeys.includes('calories_off_target'), 'food layer locked: no calories miss');
  assert.ok(!missKeys.includes('no_meals_logged'), 'food layer locked: no no_meals_logged miss');
  assert.ok(!missKeys.some((k) => k.startsWith('habit_missed') && k !== 'habit_missed_water'), 'steps/sleep/supplements/health locked: no habit misses');
});

test('unlocked layer items produce misses normally', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: B10_TARGETS,
    totals: { ...B10_ON_TARGET, kcal: 1000, proteinG: 20, hasAnyFood: true },
    closed: true,
    unlockedLayerKeys: ['workout', 'water', 'food', 'steps', 'sleep', 'supplements', 'health', 'medicine'],
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(missKeys.includes('workout_missed'));
  assert.ok(missKeys.some((k) => k.startsWith('habit_missed')));
  assert.ok(missKeys.includes('protein_short'));
  assert.ok(missKeys.includes('calories_off_target'));
  assert.ok(!missKeys.includes('no_meals_logged'));
});

test('null unlockedLayerKeys (not a coach journey) locks nothing', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: B10_TARGETS,
    totals: { kcal: 1000, proteinG: 20, waterMl: 500, hasAnyFood: true },
    closed: true,
    unlockedLayerKeys: null,
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(missKeys.includes('protein_short'), 'food counts with no coach journey');
  assert.ok(missKeys.includes('calories_off_target'));
  assert.ok(missKeys.includes('workout_missed'), 'layered items are not locked either');
  assert.ok(missKeys.some((k) => k.startsWith('habit_missed')));
});

test('null unlockedLayerKeys still charges no_meals_logged when nothing is logged', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: B10_TARGETS,
    totals: { kcal: 0, proteinG: 0, waterMl: 0, hasAnyFood: false },
    closed: true,
    unlockedLayerKeys: null,
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(missKeys.includes('no_meals_logged'));
});

test('empty unlockedLayerKeys (a coach journey with nothing unlocked) still locks food', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: B10_TARGETS,
    totals: { kcal: 1000, proteinG: 20, waterMl: 500, hasAnyFood: true },
    closed: true,
    unlockedLayerKeys: [],
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(!missKeys.includes('protein_short'), 'food stays locked for an empty journey');
  assert.ok(!missKeys.includes('calories_off_target'));
  assert.ok(!missKeys.includes('workout_missed'), 'layered items stay locked');
});

test('noMisses suppresses all miss lines but keeps earnings (easy start)', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [{ planItemId: 'w1' }],
    targets: B10_TARGETS,
    totals: { ...B10_ON_TARGET, kcal: 1000, proteinG: 20 },
    closed: true,
    unlockedLayerKeys: ['workout', 'water', 'food', 'steps', 'sleep', 'supplements', 'health', 'medicine'],
    noMisses: true,
    foodNoPenalty: false,
  });

  const missLines = day.breakdown.filter((l) => l.points < 0);
  const earnLines = day.breakdown.filter((l) => l.points > 0);

  assert.equal(missLines.length, 0, 'no miss lines when noMisses is true');
  assert.ok(earnLines.length > 0, 'earnings should still be counted');
  assert.ok(earnLines.some((l) => l.key.startsWith('item_done_')));
});

test('noMisses during inactive pause (7+ days since last showed-up)', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [{ planItemId: 'h1' }],
    targets: B10_TARGETS,
    totals: B10_ON_TARGET,
    closed: true,
    unlockedLayerKeys: ['workout', 'water', 'food', 'steps', 'sleep', 'supplements', 'health', 'medicine'],
    noMisses: true,
    foodNoPenalty: false,
  });

  const missLines = day.breakdown.filter((l) => l.points < 0);
  assert.equal(missLines.length, 0, 'no miss lines during inactive pause');
  assert.ok(day.breakdown.some((l) => l.points > 0 && l.kind === 'habit'));
});

test('foodNoPenalty suppresses no_meals_logged when food unlocked but not set up', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: { waterMl: 2500 }, // no kcal target = food not set up
    totals: { waterMl: 500, hasAnyFood: false },
    closed: true,
    unlockedLayerKeys: ['workout', 'water', 'food'],
    noMisses: false,
    foodNoPenalty: true,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(!missKeys.includes('no_meals_logged'), 'foodNoPenalty suppresses no_meals_logged');
  assert.ok(missKeys.includes('workout_missed'));
  assert.ok(missKeys.some((k) => k.startsWith('habit_missed')));
});

test('foodNoPenalty suppresses no_meals_logged when food layer is locked', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: B10_TARGETS,
    totals: { ...B10_ON_TARGET, kcal: 1000, proteinG: 20, hasAnyFood: false },
    closed: true,
    unlockedLayerKeys: ['workout', 'water'],
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(!missKeys.includes('no_meals_logged'), 'food locked suppresses no_meals_logged');
});

test('foodNoPenalty suppresses no_meals_logged when food early (before 3 showed-up days)', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: B10_PLAN_ITEMS,
    completions: [],
    targets: B10_TARGETS,
    totals: { ...B10_ON_TARGET, kcal: 1000, proteinG: 20, hasAnyFood: false },
    closed: true,
    unlockedLayerKeys: ['workout', 'water', 'food'],
    noMisses: false,
    foodNoPenalty: true,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(!missKeys.includes('no_meals_logged'), 'food early suppresses no_meals_logged');
  assert.ok(missKeys.includes('protein_short'));
  assert.ok(missKeys.includes('calories_off_target'));
});

test('water habit counts as done when WaterLog sum >= target (no miss)', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: [
      { id: 'h1', kind: 'habit', schedule: 'daily', active: true, title: 'Water 2.5L', layerKey: 'water' },
    ],
    completions: [],
    targets: { waterMl: 2500 },
    totals: { waterMl: 2600, hasAnyFood: true },
    closed: true,
    unlockedLayerKeys: ['water'],
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(!missKeys.some((k) => k.startsWith('habit_missed')), 'water met via logs: no miss');
});

test('water habit misses when WaterLog sum < target', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: [
      { id: 'h1', kind: 'habit', schedule: 'daily', active: true, title: 'Water 2.5L', layerKey: 'water' },
    ],
    completions: [],
    targets: { waterMl: 2500 },
    totals: { waterMl: 1000, hasAnyFood: true },
    closed: true,
    unlockedLayerKeys: ['water'],
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(missKeys.some((k) => k.startsWith('habit_missed')), 'water below target: miss charged');
});

test('water habit not charged when water layer is locked', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: [
      { id: 'h1', kind: 'habit', schedule: 'daily', active: true, title: 'Water 2.5L', layerKey: 'water' },
    ],
    completions: [],
    targets: { waterMl: 2500 },
    totals: { waterMl: 0, hasAnyFood: true },
    closed: true,
    unlockedLayerKeys: [],
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(!missKeys.some((k) => k.startsWith('habit_missed')), 'water locked: no miss');
});

test('medicine layer never locked (always on)', () => {
  const day = computeDay({
    localDate: B10_TODAY,
    planItems: [
      { id: 'm1', kind: 'doctor_medication', schedule: 'daily', active: true, title: 'Medication', layerKey: 'medicine' },
    ],
    completions: [],
    targets: B10_TARGETS,
    totals: B10_ON_TARGET,
    closed: true,
    unlockedLayerKeys: [],
    noMisses: false,
    foodNoPenalty: false,
  });

  const missKeys = day.breakdown.filter((l) => l.points < 0).map((l) => l.key);
  assert.ok(missKeys.includes('doctor_item_missed'), 'medicine always scores, even when no layers unlocked');
});

test('rulesVersion is v2 for all days', () => {
  const day = computeDay({
    localDate: '2026-10-14',
    planItems: [],
    completions: [],
    targets: null,
    totals: null,
    closed: true,
    unlockedLayerKeys: [],
  });
  assert.equal(day.rulesVersion, 'v2');
});