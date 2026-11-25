// A rough time for a whole routine, in whole minutes rounded to the nearest
// five: honest enough to plan a day around, never a promise. The same rule the
// customer app uses for the routines it builds itself
// (lib/core/utils/workout_duration.dart `estimateWorkoutMinutes`).
//
// A timed row takes its set length; a counted row takes about four seconds a
// rep. Rest sits between the sets of a row, and a short allowance covers
// changing over between rows. Warm-up and cool-down rows are timed and
// rest-free, so they add exactly what they say.

const SECONDS_PER_REP = 4;
const DEFAULT_REST_SECONDS = 60;
const CHANGEOVER_SECONDS = 30;

/** rows: { phase?, sets, reps?, seconds?, rest? } (the catalogue JSON shape). */
export function estimateRoutineMinutes(rows) {
  let seconds = 0;
  for (const row of rows) {
    const phase = row.phase ?? 'main';
    const sets = Math.max(1, row.sets ?? 1);
    const setSeconds = row.seconds ?? (row.reps ?? 0) * SECONDS_PER_REP;
    const rest = row.rest ?? (phase === 'main' ? DEFAULT_REST_SECONDS : 0);
    seconds += sets * setSeconds + (sets - 1) * rest;
    if (phase === 'main') seconds += CHANGEOVER_SECONDS;
  }
  return Math.max(5, Math.round(seconds / 60 / 5) * 5);
}
