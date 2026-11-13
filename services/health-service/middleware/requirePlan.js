import { requireAuth } from './requireAuth.js';
import { requireCoachJourney } from './requireCoachJourney.js';
import { requireCoachConsent } from './requireCoachConsent.js';

// The two /plan gate shapes (one-plan Contracts · API).
//
// planGated — mutations and the plan/score reads: auth + the coach journey
// flag + the person's own coach basic consent. A missing basic consent on a
// mutation is 403 CONSENT_REQUIRED; on the soft-gated reads below it is a 200
// no_plan instead, because "you have not opted in" is a state the app renders,
// not an error.
//
// planSoftGated — GET /plan/today and GET /plan: no consent check here at all.
// The controller turns a missing consent (or missing JourneyProgress) into
// 200 {state:'no_plan', reason:'no_consent'|'no_journey'}. Layer scopes
// (nutrition, medical_records, coach.supplements) are NOT this middleware's
// job either — layerState reports needs_consent in the layers array, and the
// mutation that touches a gated layer gets its 403 from the controller.
export const planGated = [
  requireAuth,
  requireCoachJourney,
  requireCoachConsent('basic'),
];

export const planSoftGated = [
  requireAuth,
  requireCoachJourney,
];
