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

// `goals` is the user's whole set. It is not read for anything today — plan items
// key off the nutrient targets, so retargeting the numbers retargets the plan
// regardless of which goals produced them — but it is accepted so the generator
// can answer "is this suggestion right for someone building muscle AND losing
// fat?" without a signature change. Named `goals` rather than `goal` because the
// one-goal reading is the thing that was wrong.
export function generatePlan({ goals = [], diet, targets, measuredActivity, hasDoctorItems = false }) {
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
