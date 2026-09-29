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

const PLAN_ITEMS = [
  { id: 'p1', kind: 'nutrition', schedule: 'daily', active: true, title: 'Hit 133 g protein' },
  { id: 'w1', kind: 'workout', schedule: '1,3,5', active: true, title: 'Workout' },
  { id: 'h1', kind: 'habit', schedule: 'daily', active: true, title: 'Sleep 7 h' },
  { id: 'r1', kind: 'rest', schedule: '7', active: true, title: 'Rest day' },
  { id: 'd1', kind: 'doctor_medication', schedule: 'daily', active: true, title: 'As advised' },
];

// A Tuesday, ISO weekday 2.
const TUE = '2026-09-29';
// A Wednesday, ISO weekday 3. The workout item is scheduled '1,3,5', so a
// Tuesday is NOT a day it is due — which is easy to miss when picking a date
// for a workout test, and silently turns an assertion about a completed
// workout into one about a day with no workout scheduled.
const WED = '2026-09-30';
// A Sunday, ISO weekday 7 — the rest day.
const SUN = '2026-10-04';

const ON_TARGET = {
  kcal: 2500,
  proteinG: 133,
  fatG: 78,
  waterMl: 2950,
  micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
};

// --- The eating-disorder guard --------------------------------------------
//
// These justify the feature existing. Everything else here is arithmetic.

test('undereating and overeating are scored identically', () => {
  // The doc's guard: "under-eating is never rewarded". Not "penalised less" —
  // never rewarded. Same points in both directions is the only way to make
  // rewarding it impossible rather than merely discouraged.
  const low = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 800 },
    targets: TARGETS,
  });
  const high = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 4200 },
    targets: TARGETS,
  });

  const lowCal = low.breakdown.find((l) => l.key === 'calories_off_target');
  const highCal = high.breakdown.find((l) => l.key === 'calories_off_target');

  assert.equal(lowCal.points, highCal.points);
  assert.equal(lowCal.points, POINTS.caloriesOffTarget);
  assert.ok(lowCal.points < 0, 'undereating must never earn points');
  // Same score, opposite direction — the only thing that differs.
  assert.equal(lowCal.direction, 'low');
  assert.equal(highCal.direction, 'high');
});

test('a day of severe undereating cannot fall further than the daily loss cap', () => {
  // A streak of very-low days is the documented trigger. The per-day loss cap
  // bounds how fast the candle drops, so a bad week cannot produce a cliff.
  let close = 500;
  for (let i = 0; i < 7; i += 1) {
    const day = computeDay({
      localDate: `2026-09-${String(20 + i).padStart(2, '0')}`,
      planItems: PLAN_ITEMS,
      totals: { ...ON_TARGET, kcal: 200, proteinG: 0, waterMl: 0 },
      targets: TARGETS,
      previousClose: close,
    });
    assert.ok(
      day.low >= close - DAILY_MAX_LOSS,
      `day ${i}: fell ${close - day.low}, cap is ${DAILY_MAX_LOSS}`,
    );
    close = day.close;
  }
  // Seven days of near-starvation still cannot zero the line.
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
    });
    return { localDate: date, close: day.close, breakdown: day.breakdown };
  });

  const run = checkForLowIntakeRun(snapshots);
  assert.ok(run, 'expected a low-intake run to be detected');
  assert.equal(run.kind, 'check_in');
  assert.equal(run.days, 5);
  // Not a miss and not negative. This is the entire point of the rule.
  assert.equal(run.points, 0);
  assert.equal(run.isMiss, false);
  // Phrased as an invitation, never as a judgement about the person.
  assert.ok(
    !/fail|lose|bad|missed|wrong|starv/i.test(run.message),
    `tone is wrong: "${run.message}"`,
  );
  assert.equal(run.action, 'review_targets');
});

test('the check-in is not affected by the wording of the label', () => {
  // Regression. The guard used to decide "was this low or high?" by regex-
  // parsing the display string "Calories 800 (32%)". Rewriting that copy for a
  // localisation pass, or changing the number format, would have silently
  // switched off the eating-disorder card while every test still passed.
  // Direction now travels as a field, so the label is free to be anything.
  const snapshots = Array.from({ length: 5 }, (_, i) => ({
    localDate: `2026-09-${20 + i}`,
    close: 100,
    breakdown: [
      {
        key: 'calories_off_target',
        label: 'بائی کیلوری کم ہیں', // any string at all
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
    });
    return { localDate: `2026-09-${20 + i}`, close: day.close, breakdown: day.breakdown };
  });
  assert.equal(checkForLowIntakeRun(snapshots), null);
});

test('a high-intake streak is NOT treated as a low-intake run', () => {
  // The symmetric bug: a detector keyed on "calories off target" rather than
  // "too few calories" would fire on binge days and tell someone they may be
  // undereating.
  const snapshots = Array.from({ length: 6 }, (_, i) => {
    const day = computeDay({
      localDate: `2026-09-${20 + i}`,
      planItems: PLAN_ITEMS,
      totals: { ...ON_TARGET, kcal: 5000 },
      targets: TARGETS,
    });
    return { localDate: `2026-09-${20 + i}`, close: day.close, breakdown: day.breakdown };
  });
  assert.equal(checkForLowIntakeRun(snapshots), null);
});

test('the guard is off by default below its threshold and has one threshold', () => {
  // If lowIntakeRunDays and the card's trigger ever drift apart, the card
  // appears on a different day than the copy promises.
  const day = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 700 },
    targets: TARGETS,
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
    completions: [
      { planItemId: 'w1' },
      { planItemId: 'h1' },
      { planItemId: 'd1' },
    ],
  });
  const empty = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: {},
    targets: TARGETS,
  });

  assert.ok(perfect.close > empty.close);
  assert.ok(Number.isFinite(perfect.close) && Number.isFinite(empty.close));
  // The first day starts at zero, not at a flattering baseline. A baseline of
  // 100 would make a month of doing nothing look like a month of doing a lot.
  assert.equal(perfect.open, 0);
});

test('one huge day cannot out-earn a run of good days', () => {
  // The chart is a trend, not a scoreboard. If a single day could swing the
  // line arbitrarily, the line would measure logging effort, not behaviour.
  let close = 0;
  for (let i = 0; i < 10; i += 1) {
    close = computeDay({
      localDate: `2026-10-${String(i + 1).padStart(2, '0')}`,
      planItems: PLAN_ITEMS,
      totals: ON_TARGET,
      targets: TARGETS,
      previousClose: close,
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
    completions: [{ planItemId: 'h1' }],
  });
  assert.equal(Number.isInteger(day.close), true, `close was ${day.close}`);
  assert.equal(day.open, 137);
});

test('an open day carries no misses, so the candle can still move up', () => {
  // Today, mid-afternoon. The miss pass runs at day close, so an unlogged
  // evening must not already have been charged as a red day.
  const day = computeDay({
    localDate: TUE,
    planItems: PLAN_ITEMS,
    totals: { ...ON_TARGET, kcal: 1000 },
    targets: TARGETS,
    previousClose: 200,
    closed: false,
  });
  assert.equal(day.breakdown.some((l) => l.points < 0), false);
  assert.ok(day.close >= day.open);
});

test('the snapshot records which rules version produced it', () => {
  // Frozen days are only reproducible if the version travels with them.
  const day = computeDay({ localDate: TUE, planItems: PLAN_ITEMS, totals: {}, targets: TARGETS });
  assert.equal(day.rulesVersion, POINTS.__rulesVersion ?? day.rulesVersion);
  assert.match(day.rulesVersion, /^v\d+$/);
});

// --- Scheduling ------------------------------------------------------------

test('a day-of-week schedule fires on exactly its own days', () => {
  // 2026-09-28 is a Monday (ISO 1), 2026-10-04 a Sunday (ISO 7).
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
  // Regression, and it was a live bug. The weekday branch only matched strings
  // containing a comma, so a bare '7' — which is exactly what planGenerator
  // emits for a rest day — fell through to "always true" and fired all seven
  // days. Every rest day was simultaneously a rest day and a missed workout.
  const sundayOnly = { schedule: '7', active: true };
  assert.equal(isScheduledFor(sundayOnly, SUN), true);
  assert.equal(isScheduledFor(sundayOnly, TUE), false);
  assert.equal(isScheduledFor(sundayOnly, '2026-10-03'), false); // Saturday

  const mondayOnly = { schedule: '1', active: true };
  assert.equal(isScheduledFor(mondayOnly, '2026-09-28'), true);
  assert.equal(isScheduledFor(mondayOnly, '2026-09-29'), false);
});

test('the weekday helper is timezone-proof', () => {
  // The whole ledger is date-keyed in the user's local calendar. If this used
  // the host's timezone, a Monday workout would silently not count for a user
  // west of the server, and the bug would only appear in production.
  const mon = { schedule: '1', active: true };
  assert.equal(isScheduledFor(mon, '2026-09-28'), true); // Monday
  assert.equal(isScheduledFor(mon, '2026-09-29'), false); // Tuesday
  // A year boundary and a leap day, both classic timezone/off-by-one traps.
  assert.equal(isScheduledFor(mon, '2027-01-04'), true); // Monday
  assert.equal(isScheduledFor(mon, '2028-02-29'), false); // Tuesday, leap day
});

test('an item whose course has ended stops counting but is not deleted', () => {
  // Stopping someone's prescription because a date passed is not this
  // service's call.
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
  // The user typed their doctor's instruction in themselves and ticked it off.
  // This is the whole reason the feature can exist in a regulated space, so it
  // must score — and nothing may tick it on their behalf.
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
  // Backfilling yesterday from this morning keeps the record, drops the
  // points. Otherwise the chart would reward logging a week late.
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

test('an auto-satisfied item is not paid twice', () => {
  // Items credited through the food log or session log carry how='auto'.
  // Paying them again here would let one breakfast satisfy a plan item twice.
  const r = computeEarns({
    planItems: PLAN_ITEMS.filter((i) => i.kind === 'nutrition'),
    completions: [{ planItemId: 'p1', how: 'auto' }],
    targets: null,
    totals: null,
    localDate: TUE,
  });
  assert.equal(r.length, 0);
});

test('a nutrition plan item is scored by the aggregate, not by ticking a box', () => {
  // Ticking "hit 133 g protein" must not be possible — protein comes from
  // logged food. If it were tickable the ledger would measure optimism.
  const r = computeMisses({
    planItems: PLAN_ITEMS.filter((i) => i.kind === 'nutrition'),
    completions: [{ planItemId: 'p1' }],
    targets: TARGETS,
    totals: { ...ON_TARGET, proteinG: 20 },
    localDate: TUE,
  });
  const miss = r.find((m) => m.key === 'protein_short');
  assert.ok(miss, 'expected a protein miss from the aggregate');
  assert.equal(miss.points, POINTS.proteinShort);
});

test('a rest day is honoured automatically, not charged as a miss', () => {
  // The generator schedules a rest day; if the scorer also charged for not
  // ticking it, the engine would be punishing its own plan.
  const r = computeMisses({
    planItems: [PLAN_ITEMS.find((i) => i.kind === 'rest')],
    completions: [],
    targets: null,
    totals: ON_TARGET,
    localDate: SUN,
  });
  const honoured = r.find((l) => l.key === 'rest_day_honoured');
  assert.ok(honoured, 'expected the rest day to be honoured');
  assert.equal(honoured.points, POINTS.restDayHonoured);
  assert.ok(honoured.points > 0);
});

test('a workout is not charged on a day it was not scheduled', () => {
  const r = computeMisses({
    planItems: [PLAN_ITEMS.find((i) => i.kind === 'workout')],
    completions: [],
    targets: TARGETS,
    totals: ON_TARGET,
    localDate: TUE, // ISO 2, not in 1,3,5
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
  });
  const miss = r.find((l) => l.key === 'workout_missed');
  assert.ok(miss, 'expected a missed workout on a scheduled day');
  assert.equal(miss.points, POINTS.plannedWorkoutMissed);
  assert.ok(miss.points < 0);
});

// --- planned vs unplanned workouts (engine level) ---------------------------
//
// scoreService.test.js covers this from the service side, where `unplannedWorkout`
// is derived and so is only ever true when no planned workout was completed. That
// leaves the engine's own guard untested: nothing anywhere can currently hand the
// engine `unplannedWorkout: true` together with `hasPlannedWorkoutDone: true`.
// So the pair is asserted here directly, where both flags are inputs.
//
// The engine guard is worth keeping even so. scoreService computing the flag
// correctly today is not a promise that the two can never disagree, and a
// double-paid day is exactly the kind of number a user would screenshot.

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
  // The double-pay case. Both flags true must yield one workout line, not two:
  // 15 for the plan item and 8 for "extra" would be 23 points for one session.
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
  // The distinction the two flags exist for. "Scheduled" and "done" are
  // different questions, and guarding on the wrong one is what made the extra
  // workout unreachable for anyone with a workout item in their plan.
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
  // The stated design reason: the score must never pay more for improvising
  // than for following the plan. If someone retunes these constants, this fails
  // rather than quietly making skipping the plan the better strategy.
  assert.ok(POINTS.unplannedWorkout < POINTS.plannedWorkoutDone);
});
