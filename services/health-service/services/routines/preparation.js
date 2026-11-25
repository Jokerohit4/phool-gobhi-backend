// Warm-up and cool-down rows for a catalogue routine, chosen by its category so
// the body part about to be loaded is the one that gets prepared: shoulders and
// upper back before pushing and pulling, hips and ankles before legs, a gentle
// ramp before cardio. A few minutes each, never a second workout.
//
// This is the rule the customer app used when it bundled its own starters
// (starter_templates/seed_types.dart `_warmUpFor` and the cool-down stretches);
// it lives here now so the catalogue is the only place routines are assembled.
// Every name must exist in the exercise library and be a timed move.

const WARM_UP = 'warm_up';
const COOL_DOWN = 'cool_down';

const EASY_WARM_UP = 'Move smoothly with your breath through a comfortable range.';
const RAMP_WARM_UP = 'Start gently and gradually increase your pace over 5 minutes.';
const SETTLE = 'Gradually slow your pace and let your breathing settle.';
const STRETCH = 'Hold gently for 30 seconds on each side, one side per set. Breathe normally; do not bounce or push into pain.';

const timed = (name, seconds, instructions = EASY_WARM_UP) => ({
  name, sets: 1, seconds, rest: 0, phase: WARM_UP, instructions,
});

export function warmUpFor(category) {
  switch (category) {
    case 'push':
      return [timed('March in Place', 120), timed('Shoulder Circles', 45), timed('Thoracic Rotation', 60)];
    case 'pull':
      return [timed('March in Place', 120), timed('Cat-Cow', 60), timed('Arm Circles', 45)];
    case 'legs':
      return [timed('March in Place', 120), timed('Standing Hip Circles', 60), timed('Ankle Circles', 30)];
    case 'cardio':
      return [timed('March in Place', 300, RAMP_WARM_UP), timed('Standing Hip Circles', 45)];
    default:
      return [timed('March in Place', 120), timed('Cat-Cow', 60), timed('Worlds Greatest Stretch', 90)];
  }
}

const STRETCHES = {
  push: ['Chest Doorway Stretch', 'Shoulder Cross-Body Stretch'],
  pull: ['Shoulder Cross-Body Stretch', 'Wrist Flexor Stretch'],
  legs: ['Hip Flexor Stretch', 'Standing Hamstring Stretch', 'Calf Stretch'],
  cardio: ['Standing Quad Stretch', 'Calf Stretch'],
  default: ['Chest Doorway Stretch', 'Hip Flexor Stretch', 'Standing Hamstring Stretch'],
};

export function coolDownFor(category, { includeMarch = true } = {}) {
  const rows = [];
  if (includeMarch) {
    rows.push({ name: 'March in Place', sets: 1, seconds: 300, rest: 0, phase: COOL_DOWN, instructions: SETTLE });
  }
  for (const name of STRETCHES[category] ?? STRETCHES.default) {
    rows.push({ name, sets: 2, seconds: 30, rest: 0, phase: COOL_DOWN, instructions: STRETCH });
  }
  return rows;
}

/**
 * The full ordered row list for a routine: warm-up, main work, cool-down.
 * A routine that supplies its own warm-up rows keeps them instead of the
 * generated ones (a run routine warms up with a walk); the category stretches
 * are always added after the cool-down.
 */
export function withCategoryPreparation(exercises, category) {
  const phaseOf = (e) => e.phase ?? 'main';
  const own = (phase) => exercises.filter((e) => phaseOf(e) === phase);
  const main = own('main').map((e) => ({ ...e, phase: 'main' }));
  const ownWarmUp = own(WARM_UP);
  const ownCoolDown = own(COOL_DOWN);
  return [
    ...(ownWarmUp.length > 0 ? ownWarmUp : warmUpFor(category)),
    ...main,
    ...ownCoolDown,
    ...coolDownFor(category, { includeMarch: ownCoolDown.length === 0 }),
  ];
}

/** Every exercise name preparation can add, so a seed can resolve them up front. */
export function preparationExerciseNames() {
  const names = new Set();
  for (const category of ['push', 'pull', 'legs', 'cardio', 'full_body']) {
    for (const row of [...warmUpFor(category), ...coolDownFor(category)]) names.add(row.name);
  }
  return [...names];
}
