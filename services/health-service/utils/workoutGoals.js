// Deterministic fitnessGoals -> routine goal mapping.
//
// fitnessGoals are the onboarding codes auth-service stores. Routine goals are
// the six categories the customer app tags starter templates with
// (RoutineGoal in lib/data/workout/starter_templates.dart). Before this, the
// assistant only saw goals as a prompt phrase and nothing checked that the
// workouts it prescribed lined up with them.
//
// Keep in sync with lib/core/utils/routine_goal_mapper.dart in the customer app.
// Order matters: the first entry of each list is the best fit.
//
// `rehabilitation` is shown to users as "Getting back into it", so it maps to
// gentle goals only and nothing here implies treatment.

export const ROUTINE_GOALS = Object.freeze([
  'muscleBuilding',
  'strength',
  'fatLoss',
  'stamina',
  'beginner',
  'mobility',
]);

export const FITNESS_GOAL_TO_ROUTINE_GOALS = Object.freeze({
  weight_loss: ['fatLoss'],
  muscle_gain: ['muscleBuilding', 'strength'],
  general_fitness: ['beginner', 'stamina'],
  flexibility_yoga: ['mobility'],
  sports_training: ['stamina', 'strength'],
  rehabilitation: ['beginner', 'mobility'],
});

const ROUTINE_GOAL_PHRASES = {
  muscleBuilding: 'muscle building',
  strength: 'strength',
  fatLoss: 'fat loss',
  stamina: 'stamina',
  beginner: 'getting started',
  mobility: 'mobility',
};

/** Distinct routine goals for a user's fitnessGoals, best fit first. */
export function routineGoalsFor(fitnessGoals) {
  const out = [];
  for (const code of Array.isArray(fitnessGoals) ? fitnessGoals : []) {
    for (const g of FITNESS_GOAL_TO_ROUTINE_GOALS[code] || []) {
      if (!out.includes(g)) out.push(g);
    }
  }
  return out;
}

export function primaryRoutineGoal(fitnessGoals) {
  return routineGoalsFor(fitnessGoals)[0] || null;
}

/**
 * The routine goal an AI-suggested template is written with.
 *
 * A goal the model supplied is kept only if it is a real routine goal; anything
 * else (missing, misspelt, invented) falls back to the user's primary goal, or
 * null when the user has none. The model can no longer put an unknown goal on a
 * template, and a template with no stated goal inherits the user's.
 */
export function normaliseTemplateGoal(rawGoal, fitnessGoals) {
  const g = typeof rawGoal === 'string' ? rawGoal.trim() : '';
  if (ROUTINE_GOALS.includes(g)) return g;
  return primaryRoutineGoal(fitnessGoals);
}

/** Templates whose goal the user has chosen first; relative order otherwise kept. */
export function orderTemplatesByGoal(templates, fitnessGoals) {
  const wanted = routineGoalsFor(fitnessGoals);
  const rank = (t) => {
    const i = wanted.indexOf(t.goal);
    return i === -1 ? wanted.length : i;
  };
  return templates
    .map((t, idx) => ({ t, idx }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.idx - b.idx)
    .map(({ t }) => t);
}

/** One-line description recording which goal a template was written for. */
export function goalDescription(goal) {
  const phrase = ROUTINE_GOAL_PHRASES[goal];
  return phrase ? `Suggested for your goal: ${phrase}.` : null;
}
