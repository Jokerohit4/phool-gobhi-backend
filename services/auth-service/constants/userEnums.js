export const ROLES = {
  CUSTOMER: 'customer',
  PARTNER: 'partner',
  GOBHI: 'gobhi',
  // A gym's own personal trainer/instructor — distinct from GOBHI_TYPES.TRAINER
  // below, which is a job-title label on an INTERNAL Phool Gobhi staff
  // account. This is a gym employee, created by their employing partner
  // (never self-signup, same posture as GOBHI — see issueSessionForUser),
  // who logs in via the same phone+OTP flow and sees their own attendance +
  // which customers they've trained in the partner app.
  TRAINER: 'trainer',
};

export const USER_TYPES = {
  GENERAL: 'general',
  SUB_PREMIUM: 'sub_premium',
  PREMIUM: 'premium',
};

export const GOBHI_TYPES = {
  TRAINER: 'trainer',
  CLEANER: 'cleaner',
  MANAGER: 'manager',
};

export const GENDERS = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
  PREFER_NOT_TO_SAY: 'prefer_not_to_say',
};

export const FITNESS_GOALS = {
  WEIGHT_LOSS: 'weight_loss',
  MUSCLE_GAIN: 'muscle_gain',
  GENERAL_FITNESS: 'general_fitness',
  FLEXIBILITY_YOGA: 'flexibility_yoga',
  SPORTS_TRAINING: 'sports_training',
  REHABILITATION: 'rehabilitation',
};

export const EXPERIENCE_LEVELS = {
  NEW_TO_GYM: 'new_to_gym',
  RESTARTING_AFTER_BREAK: 'restarting_after_break',
  EXPERIENCED: 'experienced',
};

export const FREQUENCY_INTENTS = {
  ONE_TWO: 'one_two',
  THREE_FOUR: 'three_four',
  FIVE_PLUS: 'five_plus',
};

export const VALID_ROLES = Object.values(ROLES);
export const VALID_TYPES = Object.values(USER_TYPES);
export const VALID_GOBHI_TYPES = Object.values(GOBHI_TYPES);
export const VALID_GENDERS = Object.values(GENDERS);
export const VALID_FITNESS_GOALS = Object.values(FITNESS_GOALS);
export const VALID_EXPERIENCE_LEVELS = Object.values(EXPERIENCE_LEVELS);
export const VALID_FREQUENCY_INTENTS = Object.values(FREQUENCY_INTENTS);

// Older customer-app builds sent persona ids from the onboarding persona step
// as fitnessGoals, which the FitnessGoal enum rejects (400). Newer builds send
// the enum values; these aliases keep the old builds working. Unknown values
// pass through untouched so validation still rejects real garbage.
export const LEGACY_FITNESS_GOAL_ALIASES = {
  muscle_builder: FITNESS_GOALS.MUSCLE_GAIN,
  zen_seeker: FITNESS_GOALS.FLEXIBILITY_YOGA,
  general_fit: FITNESS_GOALS.GENERAL_FITNESS,
};

// Maps legacy aliases and drops duplicates the mapping may create. Anything
// that isn't an array is returned as-is (validation decides what it means).
export function normalizeFitnessGoals(goals) {
  if (!Array.isArray(goals)) return goals;
  const mapped = goals.map((g) => (typeof g === 'string' && LEGACY_FITNESS_GOAL_ALIASES[g]) || g);
  return [...new Set(mapped)];
}
// --- Onboarding branch (2026-09-18) -----------------------------------------

export const TRAINING_LOCATION_PREFS = {
  HOME: 'home',
  GYM: 'gym',
  FITNESS_CENTRE: 'fitness_centre',
  OTHER: 'other',
};

export const APP_MODES = {
  // Booking/PAYG leads. Home shows discovery.
  GYM_SEEKER: 'gym_seeker',
  // The user already trains somewhere we don't necessarily sell. The app is a
  // workout/progress/habit tool and PAYG is demoted to a single card.
  HOME_TRACK: 'home_track',
};

export const FREE_TIME_WINDOWS = {
  MORNING: 'morning',
  AFTERNOON: 'afternoon',
  EVENING: 'evening',
  LATE_NIGHT: 'late_night',
  FLEXIBLE: 'flexible',
};

export const VALID_TRAINING_LOCATION_PREFS = Object.values(TRAINING_LOCATION_PREFS);
export const VALID_APP_MODES = Object.values(APP_MODES);
export const VALID_FREE_TIME_WINDOWS = Object.values(FREE_TIME_WINDOWS);
