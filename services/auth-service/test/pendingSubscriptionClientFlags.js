// WP10 ships the registry before the customer app adds these fields.
// A field that has landed in the app is subject to the normal parity checks.
export const pendingSubscriptionClientFlags = new Set([
  'subscriptionOffersEnabled',
  'subscriptionMedicalEnabled',
  'subscriptionWellnessEnabled',
  'modelTrainingConsentEnabled',
  'firstLogPromptEnabled',
  'planCoveredBookingEnabled',
  'coachingSessionConfirmEnabled',
]);

export function isPendingSubscriptionClientFlag(clientKey, dart) {
  return pendingSubscriptionClientFlags.has(clientKey) &&
    !new RegExp(`\\b${clientKey}\\b`).test(dart);
}
