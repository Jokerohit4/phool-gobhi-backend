// Hand-rolled validation constants, matching auth-service's
// constants/userEnums.js convention — no joi/zod anywhere in this backend,
// and a single new service isn't the place to introduce one.

export const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'fullBody'];
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other'];
export const LOGGING_TYPES = ['sets_reps_weight', 'duration', 'duration_distance'];
export const PLATFORMS = ['ios', 'android'];
export const EXERCISE_RECORD_SOURCES = ['manual', 'healthkit', 'health_connect', 'gps_tracker'];
export const DAILY_ACTIVITY_SOURCES = ['healthkit', 'health_connect'];
export const EXERCISE_RECORD_TYPES = ['cardio', 'yoga', 'other', 'run', 'walk'];

// run-tracker-spec.html §10. Server-side sanity bounds on a POSTed run —
// catches a forgot-to-stop drive home or a corrupt client payload, not a
// determined cheat (that needs mock-location detection, deferred per the
// spec's Q4).
export const RUN_MAX_ELAPSED_SECONDS = 6 * 60 * 60 + 5 * 60; // 6h + 5min grace
export const RUN_MAX_DISTANCE_METERS = 100_000;
export const RUN_MAX_AVG_SPEED_MPS = { run: 7, walk: 3 };
export const RUN_MAX_POLYLINE_BYTES = 200 * 1024;
// Client and server-recomputed distance may disagree by this much before
// it's logged as a mismatch and the server value wins.
export const RUN_DISTANCE_MISMATCH_TOLERANCE = 0.05;
