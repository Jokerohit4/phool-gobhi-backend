// Hand-rolled validation constants, matching auth-service's
// constants/userEnums.js convention — no joi/zod anywhere in this backend,
// and a single new service isn't the place to introduce one.

export const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'fullBody'];
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other'];
export const LOGGING_TYPES = ['sets_reps_weight', 'duration', 'duration_distance'];
export const PLATFORMS = ['ios', 'android'];
export const EXERCISE_RECORD_SOURCES = ['manual', 'healthkit', 'health_connect'];
export const DAILY_ACTIVITY_SOURCES = ['healthkit', 'health_connect'];
export const EXERCISE_RECORD_TYPES = ['cardio', 'yoga', 'other'];
