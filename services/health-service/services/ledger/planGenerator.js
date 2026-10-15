import { MAX_ACTIVE_PLAN_ITEMS } from './constants.js';
import { JOURNEY, DEFAULT_STEPS, DEFAULT_SLEEP_MIN } from '../journey/journeyConfig.js';

// The plan generator.
//
// ONE RULE, and it is the reason this is a separate file rather than a
// function in the target engine: this module CANNOT write a doctor-sourced
// plan item. Not "is careful not to" — cannot. `origin: 'doctor'` is not a
// value any code path below can produce, because a doctor's advice enters the
// product only through the user typing it in themselves, and that write goes
// through planService, never through here.
//
// This is the mechanical form of the decision recorded on 2026-09-27 and it
// is what keeps the app inside CDSCO's "General Wellness Software" carve-out.
// Software that generates a plan BECAUSE OF a condition is a regulated
// medical device. Software that tracks the plan a doctor already made is
// not. The difference is not a disclaimer — it is whether this function can
// emit a doctor's voice. It cannot.
//
// The tests assert this directly: generatePlan is called with a user who has
// conditions, prescriptions and uploaded lab reports in their data, and the
// output is asserted to contain zero rows with origin 'doctor' and zero rows
// whose title matches anything condition-shaped.

// A plan with too many items turns every day red, which is how the feature
// dies. The generator targets this band and stops.
const TARGET_MIN_ITEMS = 4;
const TARGET_MAX_ITEMS = 8;

// The suggested rows rebuildPlan will write, given the on-layer keys. Every
// row is origin 'suggested' (never 'user' or 'doctor'), carries its layerKey
// so rebuildPlan can deactivate a layer's rows when it turns off, and is
// daily or per-weekday scheduled. No nutrition (protein/iron) rows any more:
// food is synthesised at resolveDay time from targets and logs, not stored
// as PlanItems, so editing a target retargets tomorrow without a rebuild.
//
// `supplements` is the user's active SupplementSchedule rows (already
// filtered); each becomes one daily habit row keyed by sourceRef so a
// schedule edit updates the row in place instead of churn-creating a twin.
// The generator stays silent on supplements when the caller passes null
// (layer off) — suggesting a dose is the one thing the medical line forbids.
export function generatePlan({
  onLayerKeys = [],
  targets = null,
  workoutSlots = null,
  stepsPerDay = null,
  sleepMinutes = null,
  supplements = null,
}) {
  const on = new Set(onLayerKeys);
  const items = [];

  // --- Movement (workout layer) --------------------------------------------
  //
  // One item per stored slot, not one from measured activity: the slot is
  // the promise the Plan tab shows (a day, a template, a tap away from
  // starting it), and each scheduled day is its own tickable thing. The
  // slot's weekday is 0 = Monday .. 6 = Sunday; PlanItem schedules are
  // 1 = Monday .. 7 = Sunday (see isDueOn), hence the +1.
  const slots = Array.isArray(workoutSlots) ? workoutSlots : [];
  if (on.has('workout')) {
    for (const slot of slots) {
      const weekday = Number(slot?.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
      items.push({
        kind: 'workout',
        title: String(slot.title || 'Workout'),
        schedule: String(weekday + 1),
        origin: 'suggested',
        layerKey: 'workout',
      });
    }
  }

  // --- Rest (workout layer) ------------------------------------------------
  //
  // ONE row whose schedule lists EVERY weekday without a slot (e.g. a
  // Mon/Wed/Fri week gets "2,4,6,7"). With zero slots it is "daily"; with
  // seven slots there is no rest row — that week genuinely has none, and
  // inventing a colliding one would be worse. Layered under 'workout' so a
  // workout-off rebuild removes it with the workout rows.
  if (on.has('workout')) {
    const usedDays = new Set(slots.map((s) => Number(s?.weekday)).filter(Number.isInteger));
    const freeDays = [1, 2, 3, 4, 5, 6, 7].filter((d) => !usedDays.has(d - 1));
    if (freeDays.length === 0) {
      // seven-slot week: no rest row at all
    } else {
      items.push({
        kind: 'rest',
        title: 'Rest day',
        schedule: freeDays.length === 7 ? 'daily' : freeDays.join(','),
        origin: 'suggested',
        layerKey: 'workout',
      });
    }
  }

  // --- Water (water layer) -------------------------------------------------
  //
  // The one item the trim rule protects outright. Before any body data the
  // journey's default applies; once a NutritionTarget exists its water
  // figure is the honest one.
  if (on.has('water')) {
    const waterMl = Number(targets?.waterMl) || JOURNEY.defaultWaterMl;
    items.push({
      kind: 'habit',
      title: `Drink ${(waterMl / 1000).toFixed(1)} L water`,
      schedule: 'daily',
      origin: 'suggested',
      targetValue: waterMl,
      layerKey: 'water',
    });
  }

  // --- Steps (body layer) ----------------------------------------------------
  //
  // From the Prescription's saved target; the default is the defensive
  // floor for a caller that had none.
  if (on.has('steps')) {
    const steps = Number.isFinite(Number(stepsPerDay)) && Number(stepsPerDay) > 0
      ? Math.round(Number(stepsPerDay))
      : DEFAULT_STEPS;
    items.push({
      kind: 'habit',
      title: `Walk ${steps.toLocaleString('en-IN')} steps`,
      schedule: 'daily',
      origin: 'suggested',
      targetValue: steps,
      layerKey: 'steps',
    });
  }

  // --- Sleep (body layer) ----------------------------------------------------
  if (on.has('sleep')) {
    const minutes = Number.isFinite(Number(sleepMinutes)) && Number(sleepMinutes) > 0
      ? Math.round(Number(sleepMinutes))
      : DEFAULT_SLEEP_MIN;
    const hours = minutes / 60;
    items.push({
      kind: 'habit',
      title: `Sleep ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`,
      schedule: 'daily',
      origin: 'suggested',
      targetValue: minutes,
      layerKey: 'sleep',
    });
  }

  // --- Supplements (supplements layer) ----------------------------------------
  //
  // One daily habit row per active schedule, keyed by sourceRef so a later
  // rebuild matches the existing row instead of creating a twin. Title is
  // the user's own schedule name — the app renders supplement rows from it.
  if (on.has('supplements') && Array.isArray(supplements)) {
    for (const schedule of supplements) {
      if (!schedule?.id) continue;
      items.push({
        kind: 'habit',
        title: String(schedule.name || 'Supplement'),
        schedule: 'daily',
        origin: 'suggested',
        sourceRef: `supplement:${schedule.id}`,
        layerKey: 'supplements',
      });
    }
  }

  // --- The size cap, layer-aware -------------------------------------------
  //
  // Highest layer trims first so water (rank 0) always survives: the sort
  // puts the LOWEST rank first and the cap keeps the head of that order.
  // Within one rank, later-created items sort after earlier ones, so the
  // last workout slot goes before the first. Rest shares workout's rank
  // (same layerKey) and goes first of that pair — dropping a rest day makes
  // the engine punish the plan it generated. Order is restored afterwards
  // so the caller (and the app) still sees the plan in the order it was
  // thought up.
  const originalCount = items.length;
  if (items.length > TARGET_MAX_ITEMS) {
    const ranked = items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => trimRank(a.item) - trimRank(b.item) || a.index - b.index);
    items.length = 0;
    items.push(...ranked.slice(0, TARGET_MAX_ITEMS).sort((a, b) => a.index - b.index).map((r) => r.item));
  }

  return {
    items,
    // Surfaced so the app can say "here's what I skipped and why" rather
    // than silently handing back a shorter plan than the user expected.
    // Captured BEFORE the trim — reading items.length afterwards would
    // always report the target size and the field would be permanently null.
    trimmedFrom: originalCount > TARGET_MAX_ITEMS ? originalCount : null,
  };
}

// What the size cap takes first. Highest rank trims first — the card's rule
// — and water last of all, so "Drink water" is the one item a crowded plan
// can never lose. Keyed on layerKey, so rest (layerKey 'workout') inherits
// workout's rank: it trims after sleep/steps/supplements, and only before
// water.
const TRIM_RANK = {
  supplements: 60,
  steps: 50,
  sleep: 40,
  workout: 10,
  water: 0,
};

function trimRank(item) {
  return TRIM_RANK[item.layerKey] ?? 0;
}

// The hard ceiling, exported so the intake, the "add your own item" path and
// this generator all enforce the same number.
export { MAX_ACTIVE_PLAN_ITEMS, TARGET_MIN_ITEMS, TARGET_MAX_ITEMS };
