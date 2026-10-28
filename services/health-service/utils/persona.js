// Whether an auth-service profile (fetchUserProfileInternal) is a wellness
// user — someone who chose daily wellbeing tracking instead of workouts.
//
// auth-service owns the persona and serves it resolved (`persona`); a user who
// switched away from wellness keeps their wellness answers, so the answers
// alone must not decide this any more. The answer-based check is only the
// fallback for an auth-service that predates `persona`.
export function isWellnessProfile(profile) {
  if (!profile) return false;
  if (typeof profile.persona === 'string' && profile.persona) return profile.persona === 'wellness';
  return profile.workoutIntent === 'wellness_only' || profile.appMode === 'wellness';
}
