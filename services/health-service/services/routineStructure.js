// Validate before a replace-all update deletes any existing exercise rows.
const PHASES = ['warm_up', 'main', 'cool_down'];
function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

export function structuredExercises(exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0) throw bad('A routine needs at least one exercise');
  return exercises.map((ex, index) => {
    const phase = ex.phase ?? 'main';
    if (!PHASES.includes(phase)) throw bad('Unknown workout phase');
    if (ex.instructions != null && (typeof ex.instructions !== 'string' || ex.instructions.length > 2000)) throw bad('Instructions must be text up to 2000 characters');
    if (!Number.isInteger(ex.exerciseId) || ex.exerciseId < 1 || !Number.isInteger(ex.targetSets) || ex.targetSets < 1 || ex.targetSets > 100) throw bad('Exercise and set targets must be positive whole numbers');
    if (ex.targetDurationSeconds != null && (!Number.isInteger(ex.targetDurationSeconds) || ex.targetDurationSeconds < 1 || ex.targetDurationSeconds > 86400)) throw bad('Duration must be a positive whole number of seconds');
    if (ex.targetReps != null && (!Number.isInteger(ex.targetReps) || ex.targetReps < 1 || ex.targetReps > 1000)) throw bad('Reps must be positive whole numbers');
    if (ex.targetDurationSeconds == null && ex.targetReps == null && ex.repMin == null) throw bad('Each exercise needs a rep or duration target');
    if (ex.restSeconds != null && (!Number.isInteger(ex.restSeconds) || ex.restSeconds < 0 || ex.restSeconds > 3600)) throw bad('Rest must be 0–3600 whole seconds');
    return { ...ex, phase, instructions: ex.instructions?.trim() || null,
      ...(phase === 'main' ? {} : { repMin: null, repMax: null }), index };
  }).sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.index - b.index);
}

export function routineDescription(body) {
  if (body.description === undefined) return {};
  if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 4000)) throw bad('Routine guidance must be text up to 4000 characters');
  return { description: body.description?.trim() || null };
}
