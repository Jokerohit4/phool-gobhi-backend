// How a returning user's "why did you stop?" answer nudges their plan.
//
// Ranking only: it reorders which routine a slot gets and never changes the
// number of sessions the user chose, and it never touches injury handling,
// which stays gated on explicit consent (injuryBias in starterPlanService).
//
//   time     -> prefer shorter routines (stopping because of time)
//   boredom  -> prefer routines they have not done lately (variety)
// Other reasons (no_results, injury, alone) have no plan-ranking effect here.

const SHORT_MAX_MINUTES = 30;
const LONG_MIN_MINUTES = 60;

export function quitReasonBias(template, quitReason, recentlyDone = false) {
  if (quitReason === 'time') {
    const minutes = template?.estMinutes;
    if (!Number.isFinite(minutes)) return 0;
    if (minutes <= SHORT_MAX_MINUTES) return 4;
    if (minutes >= LONG_MIN_MINUTES) return -3;
    return 0;
  }
  if (quitReason === 'boredom') return recentlyDone ? -4 : 0;
  return 0;
}
