// Double progression for routines.
//
// The rule, per exercise that has a rep range (repMax set):
//   - Work inside repMin..repMax at one weight. Hit the current rep goal on
//     every set and the goal goes up by one rep.
//   - Hit repMax on every set and the weight goes up one step while the goal
//     resets to repMin.
//   - Sets lifted below the working weight (a deload, a drop set) do not count
//     towards a bump, and never lower the stored weight.
// Pure on purpose: the database write lives in workoutSessionService so this
// can be tested without a client.

export const WEIGHT_STEP_KG = 2.5;

/**
 * @param te   template exercise: { targetSets, targetReps, repMin, repMax,
 *             targetWeightKg, targetDurationSeconds }
 * @param sets the session's sets for that exercise: { completed, reps, weightKg }
 * @returns null when nothing should change, otherwise
 *          { kind: 'baseline'|'reps'|'weight', weightKg, targetReps }
 */
export function computeProgression(te, sets, step = WEIGHT_STEP_KG) {
  if (!te.repMax || te.targetDurationSeconds) return null;

  const done = (sets || [])
    .filter((s) => s.completed && Number(s.reps) > 0)
    .map((s) => ({ reps: Number(s.reps), weightKg: Number(s.weightKg ?? 0) }));
  if (done.length === 0) return null;

  const repMin = te.repMin ?? te.targetReps ?? 1;
  const goal = Math.min(Math.max(te.targetReps ?? repMin, repMin), te.repMax);
  const topLifted = Math.max(...done.map((s) => s.weightKg));
  const working = te.targetWeightKg ?? topLifted;
  const weighted = working > 0;

  const counted = weighted ? done.filter((s) => s.weightKg >= working) : done;
  const fullSets = counted.length >= te.targetSets;

  if (fullSets && counted.every((s) => s.reps >= te.repMax)) {
    // Bodyweight at the top of the range has nowhere to go but a new exercise.
    if (!weighted) return null;
    return { kind: 'weight', weightKg: working + step, targetReps: repMin };
  }
  if (fullSets && goal < te.repMax && counted.every((s) => s.reps >= goal)) {
    return { kind: 'reps', weightKg: weighted ? working : null, targetReps: goal + 1 };
  }
  // First finished workout for an exercise with no stored weight: remember
  // what was actually lifted so next time has something to be compared with.
  if (te.targetWeightKg == null && weighted) {
    return { kind: 'baseline', weightKg: working, targetReps: goal };
  }
  return null;
}

/** Validates and normalises the progression fields of one template exercise. */
export function progressionFields(ex) {
  const bad = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    return err;
  };
  const repMin = ex.repMin ?? null;
  const repMax = ex.repMax ?? null;
  if ((repMin == null) !== (repMax == null)) throw bad('repMin and repMax must be sent together');
  if (repMin != null) {
    if (!Number.isInteger(repMin) || !Number.isInteger(repMax) || repMin < 1 || repMax > 100 || repMax < repMin) {
      throw bad('repMin..repMax must be whole numbers, 1 to 100, with repMax >= repMin');
    }
  }
  const w = ex.targetWeightKg ?? null;
  if (w != null && (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1000)) {
    throw bad('targetWeightKg must be a number between 0 and 1000');
  }
  // The rep goal always sits inside the range; a range with no goal starts at the bottom.
  let targetReps = ex.targetReps ?? null;
  if (repMin != null && (targetReps == null || targetReps < repMin || targetReps > repMax)) {
    targetReps = repMin;
  }
  return { repMin, repMax, targetWeightKg: w, targetReps };
}
