// What a home-track user trains with, and where (onboarding audit P2,
// 2026-10-01). Asked once, at the first "Start workout" — never at signup —
// because it is the moment the answer changes what they see: which routine
// is suggested first, and what the coach assumes is in the room.
//
// Pure on purpose. The rules below are the whole feature, so they are pinned
// by unit tests without a database, and the same functions are used by the
// routine list, the suggestion engine and the coach — one reading of
// "does this routine fit", not three.

// Fixed option sets. The client renders chips from these (served in the
// personalisation `options`), so adding one needs no app release.
//
// Not the Exercise.equipment enum: that describes what an exercise USES
// (barbell, cable, machine…), this describes what a person HAS at home, and
// "resistance bands" or "a pull-up bar" are things people own that no
// exercise in the library is tagged with yet. The mapping between the two is
// EXERCISE_EQUIPMENT_NEEDS below.
export const HOME_EQUIPMENT = [
  'none',
  'dumbbells',
  'kettlebell',
  'resistance_bands',
  'pull_up_bar',
  'full_home_gym',
];

// Space is coarse on purpose: three answers a person can give without
// measuring their room. It feeds the coach (no burpee circuits for someone
// with a mat's worth of floor), not a filter — no library exercise is tagged
// with the space it needs, and inventing those tags would be a guess.
export const TRAINING_SPACES = ['small', 'room', 'outdoor'];

// Exercise.equipment -> what a person must own for it. null = nothing needed.
// barbell/machine/cable map to full_home_gym: a home setup that has them is a
// home gym, and nobody who picked "just dumbbells" should be offered a cable
// crossover.
const EXERCISE_EQUIPMENT_NEEDS = {
  bodyweight: null,
  other: null,
  dumbbell: 'dumbbells',
  kettlebell: 'kettlebell',
  barbell: 'full_home_gym',
  machine: 'full_home_gym',
  cable: 'full_home_gym',
};

/// Returns null when the value is acceptable, or an error message.
/// 'none' is exclusive: "nothing" plus "dumbbells" is a contradiction, and
/// storing it would make every fit check below ambiguous.
export function validateHomeEquipment(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((v) => !HOME_EQUIPMENT.includes(v))) {
    return `homeEquipment must be a subset of: ${HOME_EQUIPMENT.join(', ')}`;
  }
  if (value.includes('none') && value.length > 1) {
    return "homeEquipment 'none' can't be combined with other equipment";
  }
  return null;
}

export function validateTrainingSpace(value) {
  if (value === undefined || value === null) return null;
  if (!TRAINING_SPACES.includes(value)) {
    return `trainingSpace must be one of: ${TRAINING_SPACES.join(', ')}`;
  }
  return null;
}

/// Does this routine fit what the person has? `template.exercises[].exercise
/// .equipment` is the only input read from the template.
///
/// Returns null when we don't know what they have (setup never answered) —
/// deliberately distinct from `fits: true`. Unknown must not be rendered as
/// "this fits you", and must not re-rank anything.
export function equipmentFit(template, profile) {
  if (!profile?.homeSetupAt) return null;
  const owned = new Set(profile.homeEquipment ?? []);
  const missing = new Set();
  for (const te of template?.exercises ?? []) {
    const need = EXERCISE_EQUIPMENT_NEEDS[te.exercise?.equipment] ?? null;
    if (!need) continue;
    // A full home gym covers everything a home can hold.
    if (owned.has(need) || owned.has('full_home_gym')) continue;
    missing.add(need);
  }
  return { fits: missing.size === 0, missing: [...missing].sort() };
}

/// Fitting routines first, original order kept within each half (a stable
/// partition, not a re-sort). Untouched when fit is unknown.
export function rankByFit(templates, profile) {
  if (!profile?.homeSetupAt) return templates;
  const fitting = [];
  const rest = [];
  for (const t of templates) {
    (equipmentFit(t, profile)?.fits ? fitting : rest).push(t);
  }
  return [...fitting, ...rest];
}

const EQUIPMENT_PHRASES = {
  none: 'no equipment',
  dumbbells: 'dumbbells',
  kettlebell: 'a kettlebell',
  resistance_bands: 'resistance bands',
  pull_up_bar: 'a pull-up bar',
  full_home_gym: 'a full home gym',
};
const SPACE_PHRASES = {
  small: "a small space (about a mat's worth — avoid moves that travel or jump far)",
  room: 'room to move',
  outdoor: 'outdoors',
};

/// The coach's line. Fixed phrases only, so it is bounded and byte-stable
/// between turns (it sits in the cached part of the prompt). null when the
/// setup was never answered.
export function summariseHomeSetup(profile) {
  if (!profile?.homeSetupAt) return null;
  const bits = [];
  const kit = (profile.homeEquipment ?? []).map((e) => EQUIPMENT_PHRASES[e]).filter(Boolean);
  if (kit.length) bits.push(`has ${kit.join(', ')}`);
  const space = SPACE_PHRASES[profile.trainingSpace];
  if (space) bits.push(`trains in ${space}`);
  if (!bits.length) return null;
  return `Home setup: ${bits.join('; ')}. Only suggest exercises that fit this.`;
}
