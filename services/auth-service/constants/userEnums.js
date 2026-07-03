export const ROLES = {
  CUSTOMER: 'customer',
  PARTNER: 'partner',
  GOBHI: 'gobhi',
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

export const VALID_ROLES = Object.values(ROLES);
export const VALID_TYPES = Object.values(USER_TYPES);
export const VALID_GOBHI_TYPES = Object.values(GOBHI_TYPES);
export const VALID_GENDERS = Object.values(GENDERS);
export const VALID_FITNESS_GOALS = Object.values(FITNESS_GOALS);