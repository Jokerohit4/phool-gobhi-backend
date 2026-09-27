// Hand-rolled validation constants, matching auth-service's
// constants/userEnums.js convention — no joi/zod anywhere in this backend,
// and a single new service isn't the place to introduce one.

export const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'fullBody'];
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other'];
export const LOGGING_TYPES = ['sets_reps_weight', 'duration', 'duration_distance'];
export const PLATFORMS = ['ios', 'android'];
export const EXERCISE_RECORD_SOURCES = ['manual', 'healthkit', 'health_connect', 'gps_tracker'];
export const DAILY_ACTIVITY_SOURCES = ['healthkit', 'health_connect'];

// run-tracker-spec.html §10. Server-side sanity bounds on a POSTed run —
// catches a forgot-to-stop drive home or a corrupt client payload, not a
// determined cheat (that needs mock-location detection, deferred per the
// spec's Q4).
export const RUN_MAX_ELAPSED_SECONDS = 6 * 60 * 60 + 5 * 60; // 6h + 5min grace
export const RUN_MAX_DISTANCE_METERS = 100_000;
// Per-modality cap on *average* speed over moving time, not on a single leg.
// A bike is not a fast run: casual commuting sits at 5-6 m/s, a club ride
// 8-11 m/s, so the run cap of 7 would reject most real rides. 12 m/s (43 km/h)
// is a genuinely fast average and still catches a client claiming an
// impossible one.
export const RUN_MAX_AVG_SPEED_MPS = { run: 7, walk: 3, cycle: 12 };
export const RUN_MAX_POLYLINE_BYTES = 200 * 1024;
// Client and server-recomputed distance may disagree by this much before
// it's logged as a mismatch and the server value wins.
export const RUN_DISTANCE_MISMATCH_TOLERANCE = 0.05;

// The accepted GPS-tracker modalities, derived from the cap map rather than
// spelled out beside it. runService indexes RUN_MAX_AVG_SPEED_MPS by type, and
// a lookup miss there is silent: `x > undefined` is false, so an accepted type
// with no cap would skip the speed sanity check entirely instead of failing.
// Deriving the list from the keys makes that state unreachable.
export const RUN_ACTIVITY_TYPES = Object.keys(RUN_MAX_AVG_SPEED_MPS);

// Every type an ExerciseRecord row can hold, now including the GPS modes.
// Kept as its own list because the manual-exercise endpoint accepts cardio and
// yoga too, which have no GPS equivalent and no speed cap.
export const EXERCISE_RECORD_TYPES = ['cardio', 'yoga', 'other', ...RUN_ACTIVITY_TYPES];
