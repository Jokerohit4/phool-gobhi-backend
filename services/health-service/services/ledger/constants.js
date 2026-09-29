// Every number the score engine can move, in one file.
//
// This is deliberately not in the database and deliberately not
// admin-editable. The ledger is only worth anything if a red day means the
// same thing to every user on every day; a per-tenant point table would make
// two people's "+40" incomparable and there would be no shared vocabulary for
// the weekly review to reason about.
//
// RULES_VERSION is written onto every frozen ScoreDaySnapshot. Bump it when a
// value here changes, so a rule change shows up as a visible discontinuity in
// the chart instead of silently rewriting every historical day. The plan
// freezes closed days precisely so history is a record rather than a
// recomputation; a version bump is how you stay honest about the fact that a
// later retune does not apply backwards.
export const RULES_VERSION = 'v1';

// Hard ceilings, so one extraordinary day cannot swamp the chart. Without
// these the running total is a function of how much someone logged in a
// single good or bad day, which makes the line meaningless as a trend.
export const DAILY_MAX_GAIN = 60;
export const DAILY_MAX_LOSS = 40;

// Logging something more than this many days late still records it (the food
// is still food) but earns nothing. The score measures whether you followed
// the plan, and a backfilled tick did not.
export const LATE_LOGGING_WINDOW_DAYS = 2;

// The longest a pause may run, in days, inclusive of the day it starts.
//
// Capped, not unlimited, and the cap is the point. An uncapped pause is a way
// to stop the score from ever going down again, which is exactly the thing the
// score exists to do - a user could pause the day after every bad week and the
// line would stop being a record of anything while still looking like one.
// Fourteen covers a genuine illness, an injury, a holiday and a slow patch,
// which is the range this is for.
//
// Enforced in scoreService.setPause rather than only in the client, so calling
// the endpoint directly cannot buy a longer pause than the app offers.
export const MAX_PAUSE_DAYS = 14;

export const POINTS = {
  // Weighted highest, and deliberately so. Of everything in a plan, "did I
  // take the thing my doctor told me to take" is the one with a consequence
  // outside the app, and it is the item most likely to be quietly dropped by
  // everyone else. The plan's own note: this is the adherence the user
  // actually needs.
  doctorItemDone: 10,
  doctorItemMissed: -10,
  doctorAppointmentAttended: 10,
  doctorAppointmentMissed: -10,

  plannedWorkoutDone: 15,
  plannedWorkoutMissed: -15,
  // An unplanned extra workout is worth something — it is real effort the
  // user chose — but strictly less than completing the plan, so the score
  // never rewards ignoring the plan in favour of improvising.
  unplannedWorkout: 8,

  proteinMet: 10,
  proteinShort: -5,

  // Asymmetric thresholds on purpose: eating too little costs the same as
  // eating too much. The plan is explicit that this is intentional, and it is
  // also the single most important guard here — a calorie target that rewards
  // undereating is how a scoring app becomes a disordered-eating app.
  caloriesOnTarget: 10,
  caloriesOffTarget: -8,
  caloriesOnTargetRatio: 0.1, // within ±10%
  caloriesOffTargetRatio: 0.25, // beyond ±25%, either direction

  // Nudge only, never negative. A micronutrient is a suggestion to eat
  // something; punishing someone for missing an RDA on a given day is
  // nonsense, since the allowances are averages over time, not daily gates.
  microPerMet: 2,
  microMaxPerDay: 10,
  microMetRatio: 0.8,

  habitDone: 5,
  habitMissed: -3,

  allMealsLogged: 5,
  noMealsLogged: -5,

  // Rest is part of the plan. A day the plan says "rest" and the user rests
  // is a completed day, and scoring it as anything less would make the plan
  // generator's own rest days read as failures.
  restDayHonoured: 5,
};

// A plan with twenty items turns every day red, which is how the feature
// dies. The intake, the generator and the "add your own item" path all read
// this so the ceiling is enforced everywhere rather than in one place that
// the others can forget.
export const MAX_ACTIVE_PLAN_ITEMS = 20;

// The eating-disorder guard, in code rather than in a design doc.
//
// Each of these is a floor the formula cannot go below, so no combination of
// goal, weight or activity can produce a target that encourages undereating.
export const SAFETY = {
  // Never below BMR. This is the hard one: a target under BMR means eating
  // less than the body spends at rest, sustained.
  neverBelowBmr: true,
  // Absolute floors, applied after BMR so a very light person still has one.
  kcalFloorFemale: 1200,
  kcalFloorMale: 1500,
  kcalFloorOther: 1200,
  // Nobody loses faster than this. The plan's own guard, and the one the
  // intake screen states out loud ("we'll never set a target faster than 0.75
  // kg/week"), so it is an ABSOLUTE limit that does not scale with body
  // weight.
  maxWeeklyLossKg: 0.75,
  // The second, independent bound: about 1% of body weight a week. This is what
  // makes a fixed deficit reckless for a 45 kg person and conservative for a
  // 130 kg one, and it is the tighter of the two for anyone below ~143 kg.
  //
  // Kept separate from maxWeeklyLossKg on purpose. goalAdjustmentKcal enforces
  // whichever is smaller, and collapsing them into one expression is what let
  // a 200 kg user be told 1.05 kg/week by a screen promising 0.75.
  maxWeeklyLossFractionOfBodyWeight: 0.01,
  // A run of very-low-intake days gets a gentle check-in rather than a red
  // candle. Not a diagnosis, not a block — a card.
  lowIntakeRunDays: 5,
  lowIntakeRatio: 0.6, // below 60% of target, which is where the daily
  // proteinShort rule also fires
};

// The activity multipliers for the intake's guess, and for the measured
// average that replaces it after 14 days of real data.
//
// The measured path deliberately does NOT use a different set of numbers — it
// derives one of these four bands from actual logged burn. One vocabulary,
// two sources, so switching from guessed to measured can never change what
// "+100 kcal" means.
export const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
};

export const MEASURED_ACTIVITY_THRESHOLD_DAYS = 14;

// Below this much measured active burn per day, a 14-day window is treated as
// "no data" rather than as evidence of a sedentary life.
//
// The reason is a broken wearable, not a broken user. Someone who says they
// are moderately active but whose watch recorded 10 kcal a day has almost
// certainly not been wearing it, and quietly dividing their calorie target by
// a lower activity factor would shrink their target on the strength of a
// device that was in a drawer. Under-reporting someone's activity is the more
// damaging direction of the two: the very_active bug raised targets, this one
// would silently cut them.
//
// Sits below bandForMeasuredBurn's 'light' threshold of 180, so anything that
// could plausibly be a light day still counts and only true silence does not.
export const MIN_USABLE_MEASURED_BURN_KCAL = 100;

// Protein, g per kg of body weight. Ranges rather than points because the
// honest answer is a range, and showing one number implies a precision the
// evidence does not support. The midpoint is used, and the range is stored in
// the target's inputs so "Why these numbers?" can show it.
export const PROTEIN_PER_KG = {
  build_muscle: [1.6, 2.2],
  lose_fat: [1.8, 2.2],
  recomp: [1.8, 2.0],
  endurance: [1.4, 1.6],
  general_health: [1.0, 1.2],
  // Following a doctor's plan still needs a protein number, and the
  // conservative middle of the general range is the right default: this
  // branch does not prescribe, it only carries the rest of the wellness
  // layer alongside whatever the user typed in themselves.
  doctor_plan: [1.0, 1.2],
};

export const FAT_FRACTION = { min: 0.25, max: 0.3 };

// Calorie adjustment per goal, on top of maintenance. The fat-loss range is
// further constrained by SAFETY.maxWeeklyLossKg, which usually binds first —
// a 300 kcal cut is a 0.3 kg/week loss and a 500 kcal cut is 0.5, so both are
// inside the safe band for most adults and the kg/week cap is the real guard.
export const GOAL_KCAL_ADJUSTMENT = {
  build_muscle: [150, 250],
  lose_fat: [-500, -300],
  // Recomposition — same weight on the scale, more muscle and less fat —
  // nets out to roughly maintenance, so this is a small deficit rather than
  // the surplus that build_muscle gets. Two reasons it must not be folded
  // into build_muscle: it is the goal the plan's own worked example uses, and
  // a surplus is the wrong instruction for someone whose weight is meant to
  // hold still. Both ends of the range are non-positive by construction.
  recomp: [-100, 0],
  endurance: [0, 0],
  general_health: [0, 0],
  doctor_plan: [0, 0],
};

// ICMR-NIN 2020 daily allowances, by sex and age band. Adult values only —
// the intake does not collect a child's date of birth, and if that ever
// changes the whole feature needs a paediatric review rather than a
// child-sized row in this table.
//
// These are the NORMAL daily levels and are used as-is. There is no
// "therapeutic" variant anywhere in this file, and that absence is the
// mechanism behind the plan's promise that the app never recommends a
// supplement or a dose: a condition cannot raise a target, because the only
// thing that can set a target value is this table, and the only thing that
// can select a row in it is age and sex.
const ADULT_MICROS = {
  male: {
    '19-30': { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
    '31-50': { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
    '51+': { iron: 19, magnesium: 440, calcium: 1200, zinc: 17 },
  },
  female: {
    '19-30': { iron: 29, magnesium: 360, calcium: 1000, zinc: 13 },
    '31-50': { iron: 29, magnesium: 360, calcium: 1000, zinc: 13 },
    '51+': { iron: 21, magnesium: 360, calcium: 1200, zinc: 13 },
  },
  // 'other' takes the male band. This is a real simplification and it is the
  // conservative direction for iron and calcium and the non-conservative one
  // for magnesium; it is documented rather than hidden because the only
  // alternative is refusing to show a target to someone who declined a binary
  // question, which is worse.
  other: {
    '19-30': { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
    '31-50': { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
    '51+': { iron: 19, magnesium: 440, calcium: 1200, zinc: 17 },
  },
};

function ageBand(age) {
  if (age >= 51) return '51+';
  if (age >= 31) return '31-50';
  return '19-30';
}

export function microAllowances(sex, age) {
  const table = ADULT_MICROS[sex] || ADULT_MICROS.other;
  return { ...table[ageBand(Number(age) || 25)] };
}

// Millilitres per kg, plus extra on a training day. 35 ml/kg is the commonly
// used general figure; the training addend is small and deliberately
// separate, so "why is my water target higher today" has a one-line answer.
export const WATER_ML_PER_KG = 35;
export const WATER_ML_WORKOUT_ADDEND = 500;
export const FIBRE_G_PER_1000_KCAL = 14;

// Round to a number of decimal places. Half away from zero, not banker's
// rounding, so 0.125 -> 0.13 rather than 0.12.
//
// Lives here rather than in one engine because every module in the ledger
// rounds on the way into storage, and a second copy of this is how a stored
// snapshot and a re-read of it end up disagreeing in the second decimal.
export function roundTo(value, places = 2) {
  const factor = 10 ** places;
  // The epsilon nudge is what makes .005 round up. Binary floating point stores
  // 1.005 as slightly less than it, so without it half the ledger's values
  // round down and the same log totals two different ways.
  return Math.sign(value) * Math.round(Math.abs(value) * factor + Number.EPSILON * factor) / factor;
}

// Meal slots, in the order a day runs. Order is the display order, so it is
// defined here once rather than sorted at each call site.
export const MEAL_SLOTS = ['breakfast', 'lunch', 'snack', 'dinner'];

// Mirrors the FoodLogSource Prisma enum. Kept here rather than read from the
// generated client so the food logger can reject a bad value with a 400 before
// it reaches Prisma, which would otherwise surface as a 500.
//
// There is no 'manual' value, and there was a default of 'manual' in
// logFood() at one point: a caller that omitted `source` got a Prisma enum
// error at runtime, and the only tests covering it were passing a mocked
// prisma that accepted anything. 'custom' is the right default - a log the
// app made on the user's behalf without a photo or a saved meal behind it.
export const FOOD_LOG_SOURCES = ['search', 'photo_confirmed', 'saved_meal', 'custom'];
export const DEFAULT_FOOD_LOG_SOURCE = 'custom';

// Where a value gets rounded. Rounding happens on the way IN to storage, not
// on the way out, so a stored snapshot and any later re-read produce
// byte-identical numbers. Rounding at display time instead means the same log
// can total two different ways depending on which screen asks.
export const DECIMAL_PLACES = {
  nutrients: 2,
  grams: 2,
  totals: 2,
};
