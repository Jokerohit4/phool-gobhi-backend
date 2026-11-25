// These keys describe how saved answers can be used. They are independent of
// page IDs so a flow can split, combine or reorder pages without changing the planner.
const profileFields = {
  age: ['dateOfBirth'],
  trainingHistory: ['workoutIntent', 'currentlyWorksOut', 'experienceLevel', 'trainingTenure'],
  trainingLocation: ['trainingLocationPref', 'trainingLocationOther'],
  gymAccess: ['linkedGymId', 'homeUnclaimedGymId'],
  gymExpiry: ['gymSubscriptionEndDate'],
  sports: ['sportsPlayed'],
  activityTime: ['freeTimeWindow'],
  fitnessGoals: ['fitnessGoals', 'weightLossTargetKg'],
  wellnessGoals: ['wellnessFocuses'],
  wellnessRoutine: ['wellnessDayPattern', 'wellnessSleepPattern'],
  goalDetails: ['goalPreferences'],
  workoutFrequency: ['weeklyFrequencyIntent'],
};

const healthFields = {
  bodyWeight: ['weightDeclined'],
  fitnessGoals: ['broughtHere'],
  foodPreferences: ['followsDiet', 'dietType', 'mealsPerDay', 'whoCooks'],
  workRoutine: ['occupation', 'workingHours'],
};

export function readOnboardingInputs(query) {
  if (query === undefined) return null;
  if (typeof query !== 'string' || query.length > 512) {
    throw Object.assign(new Error('Check the onboarding plan inputs'), { status: 400 });
  }
  return new Set(query.split(',').filter(Boolean));
}

function fieldsFor(groups, inputs) {
  return [...new Set(Object.entries(groups).flatMap(([key, fields]) => inputs.has(key) ? fields : []))];
}

export function goalPlanProfile(profile, inputs) {
  if (!inputs) return profile;
  const result = Object.fromEntries(
    fieldsFor(profileFields, inputs).map((field) => [field, profile?.[field]]),
  );
  // Keep the selected branch even if the wellbeing questions move or auth is offline.
  if (inputs.has('wellnessOnly')) {
    result.workoutIntent = 'wellness_only';
  }
  return result;
}

export function goalPlanHealthSelect(inputs) {
  const fields = inputs ? fieldsFor(healthFields, inputs) : Object.values(healthFields).flat();
  return Object.fromEntries(fields.map((field) => [field, true]));
}
