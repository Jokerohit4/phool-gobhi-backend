import { MAX_ACTIVE_PLAN_ITEMS } from './constants.js';

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

// ---- The coach journey's layers --------------------------------------------
//
// TODO(B9): this map is copied from the Contracts section and belongs, verbatim,
// in services/journey/journeyConfig.js (B9's file — read-only for B7). Replace
// the constants below with an import from there once it exists; until then a
// copy keeps this module pure (no async import on the trim path) and the two
// must not drift.
//
// 'medicine' is always on and never locked, but the generator can never emit
// it — medicine items come only from the user transcribing their own
// prescription (see the ONE RULE above), and medicine reminders are B8's. A
// doctor item keeps whatever layerKey it already carries ('medicine' for
// medications, 'health' for tests/appointments) precisely because this
// generator never touches it.
export const JOURNEY_LAYERS = [
  { layer: 1, key: 'basics', layerKeys: ['workout', 'water'] },
  { layer: 2, key: 'food', layerKeys: ['food'] },
  { layer: 3, key: 'body', layerKeys: ['steps', 'sleep'] },
  { layer: 4, key: 'supplements', layerKeys: ['supplements'] },
  { layer: 5, key: 'health', layerKeys: ['health'] },
];

// layerKey -> the layer that owns it. Items from a higher layer are trimmed
// before items from a lower one, so water (layer 1) is the last thing the
// size cap can ever take.
export const LAYER_OF_LAYER_KEY = Object.fromEntries(
  JOURNEY_LAYERS.flatMap((l) => l.layerKeys.map((k) => [k, l.layer])),
);

// Every layerKey unlocked at or below [startLayer] — the journey's starting
// position for an experience level (new_to_gym -> 1, restarting -> 2,
// experienced -> 5, per the Contracts' startLayer).
export function layerKeysUpTo(startLayer) {
  return JOURNEY_LAYERS.filter((l) => l.layer <= Number(startLayer)).flatMap((l) => l.layerKeys);
}

// `goals` is the user's whole set. It is not read for anything today — plan items
// key off the nutrient targets, so retargeting the numbers retargets the plan
// regardless of which goals produced them — but it is accepted so the generator
// can answer "is this suggestion right for someone building muscle AND losing
// fat?" without a signature change. Named `goals` rather than `goal` because the
// one-goal reading is the thing that was wrong.
//
// `unlockedLayerKeys` selects the coach-journey generator. When it is absent
// (the coachJourney flag off, every pre-journey caller) the legacy generator
// below runs byte-for-byte as before; when present, items are created only for
// the unlocked layers, every generated item carries its layerKey, and workout
// items come from the stored `workoutSlots` rather than the measured activity.
export function generatePlan({
  goals = [],
  diet,
  targets,
  measuredActivity,
  hasDoctorItems = false,
  unlockedLayerKeys = null,
  workoutSlots = null,
  stepsPerDay = null,
}) {
  if (unlockedLayerKeys == null) {
    return generatePlanLegacy({ goals, diet, targets, measuredActivity, hasDoctorItems });
  }
  return generateJourneyPlan({
    goals,
    diet,
    targets,
    hasDoctorItems,
    unlockedLayerKeys,
    workoutSlots,
    stepsPerDay,
  });
}
function generatePlanLegacy({ goals = [], diet, targets, measuredActivity, hasDoctorItems = false }) {
  const items = [];

  // --- Nutrition ---------------------------------------------------------
  //
  // Keyed to a nutrient rather than a hardcoded number, so editing the target
  // retargets the plan item instead of leaving a stale goal in the plan that
  // can never be satisfied.
  if (targets?.proteinG) {
    items.push({
      kind: 'nutrition',
      title: `Hit ${targets.proteinG} g protein`,
      schedule: 'daily',
      origin: 'suggested',
      nutrientKey: 'proteinG',
      targetValue: targets.proteinG,
    });
  }

  // A micronutrient nudge is only generated when the target engine produced
  // one, and it names FOODS, never a supplement and never a dose. "Eat
  // something with iron" is general nutrition. "Take iron" is a treatment.
  //
  // The user's diet pattern filters which foods get named, which is why Jain
  // is in the enum at all.
  const ironFoods = ironRichFoods(diet);
  if (ironFoods) {
    items.push({
      kind: 'nutrition',
      title: `Eat 2 iron-rich foods (${ironFoods})`,
      schedule: 'daily',
      origin: 'suggested',
      nutrientKey: null,
      targetValue: null,
    });
  }

  if (targets?.waterMl) {
    items.push({
      kind: 'habit',
      title: `Drink ${(targets.waterMl / 1000).toFixed(1)} L water`,
      schedule: 'daily',
      origin: 'suggested',
    });
  }

  // --- Movement ----------------------------------------------------------
  //
  // Built from the MEASURED activity where it exists, because a plan built
  // from a guess is a plan that tells a genuinely active person to rest too
  // much. Where there is no measurement this falls back to a conservative
  // three days, which is the frequency most people can hold indefinitely.
  const daysPerWeek = measuredActivity
    ? { sedentary: 2, light: 3, moderate: 4, very_active: 5 }[measuredActivity] ?? 3
    : 3;

  // Indexed by frequency, and each entry contains exactly as many days as its
  // key — a table whose rows disagree with their own keys produces a plan that
  // asks for three sessions and schedules four, and that off-by-one only
  // shows up as an unexplained red day weeks later.
  const SPLITS = {
    2: ['1', '4'],
    3: ['1', '3', '5'],
    4: ['1', '2', '4', '6'],
    5: ['1', '2', '3', '5', '6'],
  };
  const workoutDays = SPLITS[daysPerWeek] ?? SPLITS[3];

  items.push({
    kind: 'workout',
    title: daysPerWeek >= 4 ? 'Strength session' : 'Workout',
    schedule: workoutDays.join(','),
    origin: 'suggested',
  });

  // --- Rest --------------------------------------------------------------
  //
  // Generated explicitly, and scored positively (POINTS.restDayHonoured).
  // A rest day that the user rests on is a completed day. Without this the
  // generator's own rest days would read as misses on the ledger, which
  // would be the engine punishing the plan it generated.
  //
  // Day 7 is always free, since no split above schedules it. That is
  // asserted in the tests rather than assumed, because a future split that
  // includes 7 would make the rest day collide with a workout.
  items.push({
    kind: 'rest',
    title: 'Rest day',
    schedule: '7',
    origin: 'suggested',
  });

  // --- Sleep -------------------------------------------------------------
  //
  // A fixed 7 hours for everyone, with no range and no target derived from
  // anything. Sleep guidance that varies by person is exactly the kind of
  // claim this feature does not make.
  items.push({
    kind: 'habit',
    title: 'Sleep 7 h',
    schedule: 'daily',
    origin: 'suggested',
  });

  // Trim to the band. Ordered so a trim drops the least load-bearing item
  // first: the sleep habit goes before the water habit, and both go before
  // anything nutrition or movement, because those are the items the score
  // engine weights and a plan that scores well is more useful than a plan
  // that is complete.
  const priority = { nutrition: 0, workout: 0, rest: 1, habit: 2 };
  const originalCount = items.length;
  if (items.length > TARGET_MAX_ITEMS) {
    items.sort((a, b) => (priority[b.kind] ?? 0) - (priority[a.kind] ?? 0));
    items.length = TARGET_MAX_ITEMS;
    items.sort(
      (a, b) => ['nutrition', 'workout', 'habit', 'rest'].indexOf(a.kind) -
        ['nutrition', 'workout', 'habit', 'rest'].indexOf(b.kind),
    );
  }

  return {
    items,
    // Surfaced so the app can say "here's what I skipped and why" rather than
    // silently handing back a shorter plan than the user expected. Captured
    // BEFORE the trim — reading items.length afterwards would always report
    // the target size and the field would be permanently null.
    trimmedFrom: originalCount > TARGET_MAX_ITEMS ? originalCount : null,
    hasDoctorItems,
  };
}

// ---- The coach-journey generator -------------------------------------------
//
// Same ONE RULE as above, stated again because this path is new: nothing here
// can emit a doctor item, and no generated item ever carries the layerKeys
// 'medicine' or 'health'. 'supplements' is unlocked by the journey but the
// generator stays silent on it — suggesting a supplement is the one thing the
// medical line forbids, so that layer's items come only from the user's own
// schedule (B11) and never from here.

// The water a journey user gets before any body data exists. Same value as
// JOURNEY.defaultWaterMl in the Contracts; a body-derived target replaces it
// the moment one exists.
const JOURNEY_DEFAULT_WATER_ML = 2500;

// The steps the plan names when no saved step target exists yet. The
// starter plan always writes one (starterPlanService's level defaults), so
// this is the defensive floor, not the product path.
const JOURNEY_DEFAULT_STEPS = 6000;

// What the size cap takes first. Highest layer first — the card's rule — and
// water last of all, so "Drink water" is the one item a crowded plan can
// never lose. Rest sits between the layers and the layer-1 essentials: a
// plan that drops its rest day makes the engine punish the plan it generated
// (see the legacy comment above), but it still goes before water.
const TRIM_RANK = {
  supplements: 60,
  steps: 50,
  sleep: 40,
  food: 30,
  rest: 20,
  workout: 10,
  water: 0,
};

function trimRank(item) {
  if (item.layerKey) return TRIM_RANK[item.layerKey] ?? 0;
  // Layerless generated items are rest days (and, defensively, anything the
  // map above does not know). Rest earns its own rank; anything unknown
  // trims before water too, never after.
  return item.kind === 'rest' ? TRIM_RANK.rest : TRIM_RANK.workout;
}

function generateJourneyPlan({
  goals = [], // accepted for signature parity; the journey keys items off layers, not goals
  diet,
  targets,
  hasDoctorItems = false,
  unlockedLayerKeys,
  workoutSlots,
  stepsPerDay,
}) {
  const unlocked = new Set(unlockedLayerKeys);
  const items = [];

  // --- Food (layer 2) ----------------------------------------------------
  //
  // Only when the layer is unlocked AND a nutrition target exists. Food
  // unlocked with no target or no consent is the "Set up food" card, and the
  // Contracts are explicit: that state shows "No food items, no food
  // misses". An iron nudge with no target behind it would be a food item the
  // user cannot act on, so both food items sit behind the same guard.
  if (unlocked.has('food') && targets?.proteinG) {
    items.push({
      kind: 'nutrition',
      title: `Hit ${targets.proteinG} g protein`,
      schedule: 'daily',
      origin: 'suggested',
      nutrientKey: 'proteinG',
      targetValue: targets.proteinG,
      layerKey: 'food',
    });

    const ironFoods = ironRichFoods(diet);
    if (ironFoods) {
      items.push({
        kind: 'nutrition',
        title: `Eat 2 iron-rich foods (${ironFoods})`,
        schedule: 'daily',
        origin: 'suggested',
        nutrientKey: null,
        targetValue: null,
        layerKey: 'food',
      });
    }
  }

  // --- Water (layer 1) ---------------------------------------------------
  //
  // The one item the trim rule protects outright. Before any body data the
  // journey's default applies; once a target exists its water figure is the
  // honest one.
  if (unlocked.has('water')) {
    const waterMl = Number(targets?.waterMl) || JOURNEY_DEFAULT_WATER_ML;
    items.push({
      kind: 'habit',
      title: `Drink ${(waterMl / 1000).toFixed(1)} L water`,
      schedule: 'daily',
      origin: 'suggested',
      layerKey: 'water',
    });
  }

  // --- Movement (layer 1) ------------------------------------------------
  //
  // One item per stored slot, not one item from the measured activity: the
  // slot is the promise the Plan tab shows (a day, a template, a tap away
  // from starting it), and each scheduled day is its own tickable thing.
  // The slot's weekday is 0 = Monday .. 6 = Sunday; PlanItem schedules are
  // 1 = Monday .. 7 = Sunday (see isDueOn), hence the +1.
  const slots = Array.isArray(workoutSlots) ? workoutSlots : [];
  if (unlocked.has('workout')) {
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

  // --- Rest ----------------------------------------------------------------
  //
  // The first weekday no slot covers, rather than a fixed Sunday: the slot
  // pattern can place a session on any day, and a rest item colliding with a
  // workout is the exact failure the legacy tests assert against. A
  // seven-session week has no free day, so it gets no rest item — that week
  // genuinely has none, and inventing a colliding one would be worse.
  const usedDays = new Set(slots.map((s) => Number(s?.weekday)).filter(Number.isInteger));
  const freeDay = [1, 2, 3, 4, 5, 6, 7].find((d) => !usedDays.has(d - 1));
  if (freeDay) {
    items.push({
      kind: 'rest',
      title: 'Rest day',
      schedule: String(freeDay),
      origin: 'suggested',
    });
  }

  // --- Steps and sleep (layer 3) -------------------------------------------
  //
  // Unlocked together, trimmed independently: the cap takes steps before
  // sleep because sleep is the harder thing to fake and the easier thing to
  // honour. The step figure comes from the starter plan's saved target; the
  // default is the defensive floor for a caller that had none.
  if (unlocked.has('steps')) {
    const steps = Number.isFinite(Number(stepsPerDay)) && Number(stepsPerDay) > 0
      ? Math.round(Number(stepsPerDay))
      : JOURNEY_DEFAULT_STEPS;
    items.push({
      kind: 'habit',
      title: `Walk ${steps.toLocaleString('en-IN')} steps`,
      schedule: 'daily',
      origin: 'suggested',
      layerKey: 'steps',
    });
  }

  if (unlocked.has('sleep')) {
    items.push({
      kind: 'habit',
      title: 'Sleep 7 h',
      schedule: 'daily',
      origin: 'suggested',
      layerKey: 'sleep',
    });
  }

  // --- The size cap, layer-aware -------------------------------------------
  //
  // Highest layer trims first so water (layer 1) always survives: the sort
  // puts the LOWEST rank first (water before workouts, workouts before rest,
  // and so on up the layers) and the cap keeps the head of that order.
  // Within one layer, later-created items sort after earlier ones, so the
  // last workout slot goes before the first. Order is restored afterwards so
  // the caller (and the app) still sees the plan in the order it was thought
  // up.
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
    trimmedFrom: originalCount > TARGET_MAX_ITEMS ? originalCount : null,
    hasDoctorItems,
  };
}

// Iron-rich foods by diet pattern, named in the user's own food vocabulary.
//
// Note what is absent: no dose, no supplement, no "because your iron is
// low". This is a list of foods that contain iron, which is a statement
// about food composition and not about anyone's body.
function ironRichFoods(diet) {
  switch (diet) {
    case 'vegan':
    case 'jain':
      return 'palak, chana, dal';
    case 'veg':
      return 'dal, palak, chana';
    case 'egg':
      return 'dal, eggs, palak';
    case 'non_veg':
      return 'dal, eggs, chicken';
    default:
      return 'dal, palak, chana';
  }
}

// The hard ceiling, exported so the intake, the "add your own item" path and
// this generator all enforce the same number.
export { MAX_ACTIVE_PLAN_ITEMS, TARGET_MIN_ITEMS, TARGET_MAX_ITEMS };
