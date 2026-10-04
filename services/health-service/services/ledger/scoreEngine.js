import {
  DAILY_MAX_GAIN,
  DAILY_MAX_LOSS,
  LATE_LOGGING_WINDOW_DAYS,
  POINTS,
  RULES_VERSION,
  SAFETY,
  BIOLOGICAL_TARGETS,
} from './constants.js';

// The score engine.
//
// Two properties make this a ledger rather than a mood, and both are enforced
// here rather than trusted to the caller:
//
//   1. CLOSED DAYS ARE FROZEN. computeDay produces a day's full result from
//      that day's rows, and it is written once. Every later read of that day
//      returns the stored snapshot, even if a rule value has changed since.
//      A candle whose close can move tomorrow is not a candle.
//
//   2. POINTS FLOW ONLY FORWARD WITHIN A DAY. The engine returns a running
//      total and a breakdown; it never decrements. The only thing that can
//      subtract from a day is the miss pass, which runs once, at day close,
//      over items that were scheduled and not done.
//
// Nothing here is medical, nothing here interprets a condition, and nothing
// here reads a document. The engine is a function of plan items, food logs
// and workout rows, all of which the user controls or the user already logs.

const MICROS_TRACKED = ['iron', 'magnesium', 'calcium', 'zinc'];

function pct(actual, target) {
  if (!target || target <= 0) return null;
  return actual / target;
}

// --- Day close -------------------------------------------------------------

// Charges everything that was scheduled and not done.
//
// The miss pass is deliberately NOT symmetrical with the earn pass. A missed
// workout is -15 because not training on a day you planned to is a real gap
// in the plan. A missed micronutrient is 0, because an RDA is an average over
// time and not hitting it on one Tuesday is not an event.
export function computeMisses({
  planItems = [],
  completions = [],
  targets = null,
  totals = null,
  localDate,
}) {
  const done = new Set(completions.map((c) => c.planItemId));
  const lines = [];

  for (const item of planItems) {
    if (!isScheduledFor(item, localDate)) continue;
    if (done.has(item.id)) continue;

    switch (item.kind) {
      case 'doctor_medication':
      case 'doctor_test':
        lines.push(
          line('doctor_item_missed', `${item.title} not taken`, item.kind, POINTS.doctorItemMissed, item),
        );
        break;
      case 'doctor_appointment':
        // An appointment in the future is not a miss. The appointment screen
        // creates the item on the day it happens, and a follow-up dated weeks
        // out must not sit in the plan as a permanent -10.
        if (item.endsOn && item.endsOn > localDate) break;
        if (isFutureAppointment(item, localDate)) break;
        lines.push(
          line('doctor_appointment_missed', `${item.title} missed`, item.kind, POINTS.doctorAppointmentMissed, item),
        );
        break;
      case 'workout':
        lines.push(
          line('workout_missed', `${item.title} missed`, item.kind, POINTS.plannedWorkoutMissed, item),
        );
        break;
      case 'habit':
        lines.push(line('habit_missed', `${item.title} not done`, item.kind, POINTS.habitMissed, item));
        break;
      case 'rest':
        // A rest day that was rested on is a completed day, not an absence.
        // See POINTS.restDayHonoured.
        lines.push(
          line('rest_day_honoured', `Rested · ${item.title}`, item.kind, POINTS.restDayHonoured, item),
        );
        break;
      // 'nutrition' items are evaluated as aggregates below, not per-item:
      // "hit 130 g protein" is satisfied by the food log, not by a tap, so
      // there is no per-item miss to charge. Falling short of the target is
      // handled by the aggregate rules so it is charged once, not per line.
      default:
        break;
    }
  }

  // Aggregate nutrition rules. Each fires at most once regardless of how many
  // plan items mention the same nutrient — otherwise a plan with both "hit
  // 130 g protein" and "get to 130 g protein" would be charged twice.
  if (targets && totals) {
    if (targets.proteinG > 0) {
      const ratio = pct(totals.proteinG || 0, targets.proteinG);
      if (ratio !== null && ratio < 0.6) {
        lines.push({
          key: 'protein_short',
          label: `Protein ${Math.round(totals.proteinG)} g (${Math.round(ratio * 100)}%)`,
          kind: 'nutrition',
          points: POINTS.proteinShort,
        });
      }
    }
    if (targets.kcal > 0) {
      const ratio = pct(totals.kcal || 0, targets.kcal);
      // A magnitude test, so under-eating and over-eating are handled by the
      // same branch and cost the same. Writing this as two comparisons
      // (`ratio < 0.75 || ratio > 1.25`) would be one refactor away from
      // becoming an asymmetry, and the asymmetry is the single thing this
      // rule must never have.
      const magnitude = ratio === null ? 0 : Math.abs(1 - ratio);
      if (magnitude > POINTS.caloriesOffTargetRatio) {
        lines.push({
          key: 'calories_off_target',
          label: `Calories ${Math.round(totals.kcal)} (${Math.round((ratio ?? 0) * 100)}%)`,
          kind: 'nutrition',
          points: POINTS.caloriesOffTarget,
          // Which side of the target, as data. The low-intake guard below
          // needs this, and it used to recover it by regex-parsing the label
          // string — so a copywriter reformatting "Calories 800 (32%)" would
          // have silently switched off the eating-disorder check while every
          // test still passed. Same points either way; only this field
          // differs.
          direction: ratio !== null && ratio < 1 ? 'low' : 'high',
        });
      }
    }
  }

  // "Nothing logged at all" is its own line rather than being folded into the
  // calories rule, because a day with no food log is a different situation
  // from a day of tracked eating that missed the target, and conflating them
  // makes both numbers mean less.
  if (!totals || !totals.hasAnyFood) {
    lines.push({
      key: 'no_meals_logged',
      label: 'Nothing logged',
      kind: 'nutrition',
      points: POINTS.noMealsLogged,
    });
  }

  return lines;
}

// --- Earned points ---------------------------------------------------------

export function computeEarns({
  planItems = [],
  completions = [],
  targets = null,
  totals = null,
  localDate,
  late = false,
  hasPlannedWorkout = false,
  hasPlannedWorkoutDone = false,
  unplannedWorkout = false,
  restDay = false,
}) {
  const done = new Set(completions.map((c) => c.planItemId));
  const lines = [];

  // A late completion records that the thing happened but earns nothing. The
  // check is on the item's own date, not the wall clock, so a user backfilling
  // yesterday's tablet this morning gets the record without the points.
  const latePenalty =
    late || (completions.some((c) => c.late) ?? false);

  for (const item of planItems) {
    if (!isScheduledFor(item, localDate)) continue;
    if (!done.has(item.id)) continue;

    // An auto-satisfied item already credited through the food log or the
    // session log, so paying it again here is double-counting. The completion
    // row says which.
    const completion = completions.find((c) => c.planItemId === item.id);
    if (completion && completion.how === 'auto') continue;

    let points = 0;
    let label = item.title;
    switch (item.kind) {
      case 'doctor_medication':
      case 'doctor_test':
        points = POINTS.doctorItemDone;
        label = `${item.title} taken`;
        break;
      case 'doctor_appointment':
        points = POINTS.doctorAppointmentAttended;
        label = `${item.title} attended`;
        break;
      case 'workout':
        points = POINTS.plannedWorkoutDone;
        label = `${item.title} done`;
        break;
      case 'habit':
        points = POINTS.habitDone;
        label = item.title;
        break;
      case 'rest':
        points = POINTS.restDayHonoured;
        label = `Rested · ${item.title}`;
        break;
      case 'nutrition':
        // Handled in the aggregate block below. A nutrition item is satisfied
        // by the food log, never by a tap, so there is nothing to pay here.
        continue;
      default:
        continue;
    }

    lines.push(line(`item_done_${item.id}`, label, item.kind, points, item, latePenalty));
  }

  // An unplanned workout — real effort, paid at less than completing the plan so
  // the score never rewards skipping the plan in favour of improvising.
  //
  // The guard is `hasPlannedWorkoutDone`, not `hasPlannedWorkout`. Those are
  // different questions and the difference is the whole point of the line: a
  // user who trained on their scheduled-workout day but never ticked it off has
  // both done a workout and left the plan item unclaimed, and that is the
  // person this is meant to pay. Guarding on "was a workout scheduled" instead
  // meant anyone with a workout item in their plan could never see these points
  // at all, however they actually trained.
  if (unplannedWorkout && !hasPlannedWorkoutDone) {
    lines.push({
      key: 'workout_unplanned',
      label: 'Extra workout',
      kind: 'workout',
      points: POINTS.unplannedWorkout,
    });
  }

  if (targets && totals) {
    const proteinRatio = pct(totals.proteinG || 0, targets.proteinG);
    if (proteinRatio !== null && proteinRatio >= 0.9) {
      lines.push({
        key: 'protein_met',
        label: `Protein ${Math.round(totals.proteinG)} g (${Math.round(proteinRatio * 100)}%)`,
        kind: 'nutrition',
        points: POINTS.proteinMet,
      });
    }

    const kcalRatio = pct(totals.kcal || 0, targets.kcal);
    if (kcalRatio !== null && Math.abs(1 - kcalRatio) <= POINTS.caloriesOnTargetRatio) {
      lines.push({
        key: 'calories_on_target',
        label: `Calories ${Math.round(totals.kcal)} (${Math.round(kcalRatio * 100)}%)`,
        kind: 'nutrition',
        points: POINTS.caloriesOnTarget,
      });
    }

    // All main meals logged. Rewards honesty, not good food — someone logging
    // a plate of Maggi every day gets this and should.
    if (totals.mealSlotsCovered >= 3) {
      lines.push({
        key: 'all_meals_logged',
        label: 'All main meals logged',
        kind: 'nutrition',
        points: POINTS.allMealsLogged,
      });
    }

    // Micronutrients. Nudge only, capped, never negative.
    let microPoints = 0;
    const microHit = [];
    for (const key of MICROS_TRACKED) {
      const target = targets.micros?.[key];
      if (!target) continue;
      const got = totals[key];
      if (got !== undefined && got !== null && pct(got, target) >= POINTS.microMetRatio) {
        microPoints += POINTS.microPerMet;
        microHit.push(key);
      }
    }
    if (microPoints > 0) {
      lines.push({
        key: 'micros_met',
        label: `Key nutrients met (${microHit.join(', ')})`,
        kind: 'nutrition',
        points: Math.min(microPoints, POINTS.microMaxPerDay),
      });
    }
  }

  return lines;
}

// --- Assembly --------------------------------------------------------------

// Produces the full frozen result for one day: open, high, low, close and the
// full breakdown.
//
// `open` is the previous day's close, or 0 for the very first day. Starting at
// 0 rather than at a flattering baseline is the plan's explicit decision and
// it is also the only one that makes "my health portfolio is up 214" mean
// anything — a baseline that began at 100 would make a user who did nothing
// for a month look identical to one who did a lot.
export function computeDay({
  localDate,
  previousClose = 0,
  planItems = [],
  completions = [],
  targets = null,
  totals = null,
  closed = true,
  hasPlannedWorkout = false,
  hasPlannedWorkoutDone = false,
  unplannedWorkout = false,
  paused = false,
}) {
  // A paused day is neutral, and it is neutral in a specific way: not scored,
  // not merely scored as zero.
  //
  // Running the normal path and then zeroing the result would be wrong twice
  // over. It would write an empty breakdown that reads exactly like a day the
  // user skipped every item on, and it would leave the caps and the earn rules
  // free to move a number the user never earned. So the day returns before any
  // of that: no earn, no miss, and open == high == low == close, which keeps
  // the chain contiguous so the next real day resumes from the same close.
  //
  // `paused` is returned on the day object and carried into the snapshot, which
  // is the only way a reader can tell this apart from a genuine zero day.
  if (paused) {
    return {
      localDate,
      open: previousClose,
      high: previousClose,
      low: previousClose,
      close: previousClose,
      grossGain: 0,
      grossLoss: 0,
      capped: false,
      breakdown: [],
      paused: true,
      rulesVersion: RULES_VERSION,
    };
  }

  const earns = computeEarns({
    planItems,
    completions,
    targets,
    totals,
    localDate,
    hasPlannedWorkout,
    hasPlannedWorkoutDone,
    unplannedWorkout,
  });
  const misses = closed ? computeMisses({ planItems, completions, targets, totals, localDate }) : [];

  const all = [...earns, ...misses];

  // Apply the caps. Gain and loss are capped independently, which is why a day
  // can be capped at +60 and -40 and still net to +20.
  let gain = 0;
  let loss = 0;
  for (const l of all) {
    if (l.points > 0) gain += l.points;
    else loss += l.points;
  }
  const cappedGain = Math.min(gain, DAILY_MAX_GAIN);
  const cappedLoss = Math.max(loss, -DAILY_MAX_LOSS);

  const close = previousClose + cappedGain + cappedLoss;

  return {
    localDate,
    open: previousClose,
    high: previousClose + Math.max(cappedGain, 0),
    low: previousClose + Math.min(cappedLoss, 0),
    close,
    grossGain: gain,
    grossLoss: loss,
    // A day where the caps bound is worth knowing about: without this flag a
    // user who maxes out +60 every day has no way to tell whether the chart
    // is measuring them or measuring the ceiling.
    capped: gain > DAILY_MAX_GAIN || loss < DAILY_MAX_LOSS,
    breakdown: all.map((l) => ({
      key: l.key,
      label: l.label,
      kind: l.kind,
      points: l.points,
      itemId: l.itemId ?? null,
      late: l.late ?? false,
      // Carried through to the snapshot so the low-intake guard reads a field
      // rather than re-deriving intent from the label text.
      ...(l.direction ? { direction: l.direction } : {}),
    })),
    // Definite on both paths. A reader must never have to treat a missing
    // `paused` as false, for the same reason getSafetyFlag normalises null to a
    // definite shape: absent and false are the same answer here, and should not
    // look different on the wire.
    paused: false,
    rulesVersion: RULES_VERSION,
  };
}

// --- The eating-disorder guard ---------------------------------------------

// A run of very-low-intake days gets a gentle check-in instead of a red
// candle.
//
// This is the one place in the engine that produces something other than a
// number, and it is deliberately not a block and not a warning about weight.
// It fires on INTAKE BEING LOW, which is a fact about the log, not a judgement
// about the person — which is what makes it safe to show to someone who has
// not asked for it.
export function checkForLowIntakeRun(snapshots) {
  if (snapshots.length < SAFETY.lowIntakeRunDays) return null;

  const recent = snapshots.slice(-SAFETY.lowIntakeRunDays);
  const lowDays = recent.filter((s) => {
    const kcal = s.breakdown?.find((l) => l.key === 'calories_off_target');
    // Direction is a field on the line, not something recovered from the
    // label. Only the LOW side counts: a run of days eating far too much is a
    // different situation and must not produce a "you may be undereating"
    // card.
    return kcal && kcal.direction === 'low';
  });

  if (lowDays.length < SAFETY.lowIntakeRunDays) return null;

  return {
    kind: 'check_in',
    days: lowDays.length,
    // Zero and isMiss false on purpose: this is an invitation, and it must not
    // be summable into a score by a caller that adds up every line. The plan's
    // guard is that undereating is never rewarded AND never punished into a
    // red candle — it becomes a conversation starter instead.
    points: 0,
    isMiss: false,
    // Never phrased as advice about eating more or less. The plan's guard is
    // that the app does not coach intake, so the copy hands the decision to
    // the user and offers a way to turn the numbers off.
    message:
      'Your logged intake has been low for several days. If that matches how you are eating, nothing needs to change. If it does not, the calorie numbers may not be right for you — you can edit or turn them off.',
    action: 'review_targets',
  };
}

// --- Helpers ---------------------------------------------------------------

export function isScheduledFor(item, localDate) {
  if (!item.active) return false;

  // A course of tablets that ended. The item stops counting but is not
  // deleted — stopping someone's prescription because a date passed is not
  // this service's call.
  if (item.endsOn && item.endsOn < localDate) return false;

  const schedule = item.schedule || 'daily';
  if (schedule === 'daily') return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(schedule)) return schedule === localDate;
  if (schedule === 'weekly') return true;

  // Comma-separated ISO weekdays, 1 = Monday .. 7 = Sunday (the plan's
  // convention, matching WorkoutPlanDay.dayIndex). A date is converted with
  // the same helper the rest of the service uses rather than Date#getDay, so
  // a plan scheduled "Mon Wed Fri" behaves the same in IST as it does
  // anywhere else.
  //
  // A bare number is a single-day schedule and must be treated as one. It
  // used to fall through to "always true", which meant a rest day scheduled
  // for '7' fired on all seven days — the generator emits exactly that string
  // — so every rest day was silently both a rest day and a missed workout.
  if (/^\d+(?:\s*,\s*\d+)*$/.test(schedule)) {
    const wanted = schedule.split(',').map((s) => Number(s.trim())).filter(Boolean);
    return wanted.includes(isoWeekday(localDate));
  }
  return true;
}

export function isFutureAppointment(item, localDate) {
  // A doctor's appointment carries its date in the title slot's schedule via
  // the appointment record, so a future one simply is not scheduled for
  // today and isScheduledFor already returned false for it.
  return false;
}

function isoWeekday(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  if (!y || !m || !d) return 0;
  // Date.UTC so this is the calendar weekday of that Y-M-D, independent of
  // the host's timezone. Using new Date(y, m-1, d) would be correct too, but
  // the UTC form cannot be shifted by a machine in a different zone from the
  // server, which is a bug this codebase has already been bitten by.
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

function line(key, label, kind, points, item, late = false) {
  return {
    key,
    label,
    kind,
    points: late ? 0 : points,
    itemId: item?.id ?? null,
    late,
  };
}

export { LATE_LOGGING_WINDOW_DAYS, MICROS_TRACKED };

// --- Biological Scoring ----------------------------------------------------

/**
 * Computes a biological score (0-100) from the caller's biomarkers. Markers
 * with no entry in BIOLOGICAL_TARGETS are skipped, so a caller may pass every
 * stored metric and let this decide which ones it can score.
 * @param {Array} biomarkers - List of { marker: string, value: number }
 */
export function computeBiologicalScore(biomarkers = []) {
  if (!biomarkers || biomarkers.length === 0) return null;

  let totalWeightedScore = 0;
  let totalWeightUsed = 0;

  for (const { marker, value } of biomarkers) {
    const target = BIOLOGICAL_TARGETS[marker.toLowerCase()];
    if (!target) continue;

    let markerScore = 0;
    if (target.idealMax !== undefined) {
      // Lower is better (e.g., HbA1c, LDL)
      if (value <= target.idealMax) markerScore = 100;
      else if (value <= target.warningMax) markerScore = 50;
      else markerScore = 0;
    } else if (target.idealMin !== undefined) {
      // Higher is better (e.g., HDL)
      if (value >= target.idealMin) markerScore = 100;
      else if (value >= target.warningMin) markerScore = 50;
      else markerScore = 0;
    }

    totalWeightedScore += markerScore * target.weight;
    totalWeightUsed += target.weight;
  }

  if (totalWeightUsed === 0) return null;
  return Math.round(totalWeightedScore / totalWeightUsed);
}

/**
 * Blends the behavioral ledger score with the biological state score.
 * @param {number} ledgerClose - The latest close from computeDay.
 * @param {number} bioScore - The result of computeBiologicalScore.
 */
export function computeBlendedHealthScore(ledgerClose, bioScore) {
  // The ledgerClose is a running total. We need to normalize it.
  // For the MVP, we assume a "Healthy behavioral trend" is around 500 points.
  // This is a heuristic and should be tuned based on real data.
  const behavioralNormalized = Math.min(100, Math.max(0, (ledgerClose / 500) * 100));
  
  if (bioScore === null) return behavioralNormalized;

  // Blend: 40% Behavioral, 60% Biological
  const weightBeh = 0.4;
  const weightBio = 0.6;

  return Math.round((behavioralNormalized * weightBeh) + (bioScore * weightBio));
}
