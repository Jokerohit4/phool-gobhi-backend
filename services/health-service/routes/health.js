import { Router } from 'express';
import { requireAuth, requireRole, requireInternal } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import * as consentCtrl from '../controllers/consentController.js';
import * as exerciseCtrl from '../controllers/exerciseController.js';
import * as templateCtrl from '../controllers/templateController.js';
import * as sessionCtrl from '../controllers/sessionController.js';
import * as activityCtrl from '../controllers/activityController.js';
import * as progressCtrl from '../controllers/progressController.js';
import * as biometricCtrl from '../controllers/biometricController.js';
import * as personalisationCtrl from '../controllers/personalisationController.js';
import * as suggestionFeedbackCtrl from '../controllers/suggestionFeedbackController.js';
import * as exportCtrl from '../controllers/exportController.js';
import * as goalCtrl from '../controllers/goalController.js';
import * as statsCtrl from '../controllers/statsController.js';
import * as nudgeCtrl from '../controllers/nudgeController.js';
import * as recapCtrl from '../controllers/recapController.js';
import * as retentionCtrl from '../controllers/retentionController.js';
import * as adminCtrl from '../controllers/adminController.js';

const router = Router();

// Every customer-facing route is server-side gated on the healthMetrics
// flag, not just client-hidden — same posture challenge-service takes with
// streaksCoins, and more important here since this feature collects new
// personal (and DPDP-sensitive) data.
const gated = [requireAuth, requireFeatureFlag('healthMetrics')];

// Two features sit behind their OWN flags on top of healthMetrics, because
// they need legal sign-off that the rest of the health layer does not (see
// docs/phool-gobhi-counsel-brief-20260908.html):
//
//   healthPersonalisation — the only consent-bearing write in this service
//     (a non-neutral programming mode records a privacyVersion). The consent
//     wording has to be reviewed before a real user ever agrees to it.
//   recapSharing — the only feature producing an artifact intended to leave
//     the platform. The payload carries no PII by construction, but "we
//     believe it carries no PII" is exactly the sort of claim worth having
//     checked before it becomes shareable.
//
// Both are additive, so healthMetrics can be switched on to test the logging
// loop while these two stay off.
const personalisationGated = [
  requireAuth,
  requireFeatureFlag('healthMetrics'),
  requireFeatureFlag('healthPersonalisation'),
];
const recapGated = [
  requireAuth,
  requireFeatureFlag('healthMetrics'),
  requireFeatureFlag('recapSharing'),
];

// ---- Consent -------------------------------------------------------------
router.post('/consent', ...gated, consentCtrl.grantConsent);
router.delete('/consent', ...gated, consentCtrl.revokeConsent);
router.get('/consent/status', ...gated, consentCtrl.getConsentStatus);

// ---- Exercise library ------------------------------------------------
router.get('/exercises', ...gated, exerciseCtrl.searchExercises);
router.post('/exercises', ...gated, exerciseCtrl.createCustomExercise);
router.get('/exercises/:id', ...gated, exerciseCtrl.getExerciseDetail);
router.get('/exercises/:id/history', ...gated, exerciseCtrl.getExerciseHistory);

// ---- Routines (templates) ---------------------------------------------
router.get('/templates', ...gated, templateCtrl.listTemplates);
router.post('/templates', ...gated, templateCtrl.createTemplate);
router.put('/templates/:id', ...gated, templateCtrl.updateTemplate);
router.delete('/templates/:id', ...gated, templateCtrl.deleteTemplate);

// ---- Workout sessions ---------------------------------------------------
router.post('/sessions', ...gated, sessionCtrl.startSession);
router.get('/sessions', ...gated, sessionCtrl.listSessions);
// Must be registered before /sessions/:id — otherwise "today" is parsed as
// the :id param (same route-ordering footgun the app.js /health comment
// already calls out for this service).
router.get('/sessions/today', ...gated, sessionCtrl.getTodaySession);
router.get('/sessions/:id', ...gated, sessionCtrl.getSessionDetail);
router.patch('/sessions/:id/sets/:setId', ...gated, sessionCtrl.updateSet);
router.post('/sessions/:id/exercises', ...gated, sessionCtrl.addExerciseToSession);
router.post('/sessions/:id/exercises/:sessionExerciseId/sets', ...gated, sessionCtrl.addSetToExercise);
// Finishing a session is what triggers the gamified-layer coin check (see
// sessionController.finishSession) — kept as one PATCH rather than a
// separate /finish route, since "set endedAt" is the only state transition
// that matters here.
router.patch('/sessions/:id', ...gated, sessionCtrl.finishSession);

// ---- Cardio/yoga/other quick logging + device-synced activity ---------
router.post('/exercise-records', ...gated, activityCtrl.createExerciseRecord);
router.get('/exercise-records', ...gated, activityCtrl.listExerciseRecords);
router.post('/daily-activity/sync', ...gated, activityCtrl.syncDailyActivity);
router.get('/daily-activity', ...gated, activityCtrl.getDailyActivity);

// ---- Progress -------------------------------------------------------------
router.get('/progress/summary', ...gated, progressCtrl.getProgressSummary);
router.get('/progress/muscle-readiness', ...gated, progressCtrl.getMuscleReadiness);

// ---- Biometric entries (Fitness+ FR-12 + Health+ FR-01) -----------------
// One table, one set of endpoints for both: Fitness+ surfaces weight and
// body_fat ("Track body"), Health+ Phase 1 adds resting HR / sleep / steps /
// HRV / stress on the same schema, wearable-ready. POST accepts either a
// single {metric,value} or {entries:[...]} for the multi-metric quick-add.
router.post('/biometrics', ...gated, biometricCtrl.upsertEntries);
router.get('/biometrics', ...gated, biometricCtrl.listEntries);
// Must precede the :metric route below so "latest" isn't parsed as a metric.
router.get('/biometrics/latest', ...gated, biometricCtrl.getLatest);
router.delete('/biometrics/:metric/:localDate', ...gated, biometricCtrl.deleteEntry);

// ---- Suggestion feedback (FR-15) ----------------------------------------
// The impression POST fires when a suggestion is shown, the vote PATCH when
// the user reacts to it — both halves are needed for GS-5 to mean anything.
router.post('/suggestions/impressions', ...gated, suggestionFeedbackCtrl.recordImpression);
router.patch('/suggestions/impressions/:id/vote', ...gated, suggestionFeedbackCtrl.recordVote);

// ---- Personalisation (FR-25/26/27) --------------------------------------
// GET never 404s — "skipped the whole setup" is a valid state and returns
// the same empty shape, so Settings renders without branching.
router.get('/personalisation', ...personalisationGated, personalisationCtrl.getProfile);
router.put('/personalisation', ...personalisationGated, personalisationCtrl.updateProfile);
// Separate route because this is the consent-bearing write: switching to a
// personalised mode requires a privacyVersion, switching back to neutral
// never does.
router.put('/personalisation/programming-mode', ...personalisationGated, personalisationCtrl.setProgrammingMode);

// ---- Weekly recap (FR-13) -----------------------------------------------
// Numbers only — the client renders the shareable card. No name/gym/photo in
// the payload at all, so the "no PII on the card" guarantee holds no matter
// which client renders it.
router.get('/recap', ...recapGated, recapCtrl.getWeeklyRecap);

// ---- Data export (FR-16) ------------------------------------------------
router.get('/export', ...gated, exportCtrl.exportMyData);

// Internal — booking-service fires this on every verified check-in
// (self-checkin, partner-verify, manual-override, member-checkin), same
// fan-out that already feeds challenge-service's /internal/attendance-events.
// Not flag-gated at the route level — the handler checks healthMetrics
// itself, so booking-service can call this unconditionally and it's inert
// until an admin turns the phase on.
router.post('/internal/attendance-events', requireInternal, sessionCtrl.recordAttendanceForWorkoutInternal);

// DPDPA erasure — the internal twin of DELETE /me below, called by
// auth-service's account-deletion orchestration. Not flag-gated: health data
// must be deletable even with healthMetrics switched off, or a user who
// tried the feature during a pilot could never get their data removed.
router.post('/internal/erase/:userId', requireInternal, consentCtrl.eraseUserInternal);
// DPDPA access right (s.11) - the read twin of /internal/erase above. Called
// by auth-service's platform-wide export fan-out; internal only, never
// reachable through the gateway.
router.get('/internal/export/:userId', requireInternal, exportCtrl.exportUserInternal);

// ---- Account-wide deletion (called by the same flow that deletes the rest
// of a user's account — see auth-service's onDeleteAccount). Deliberately
// NOT flag-gated — same reasoning as challenge-service's refund route: a
// user must always be able to delete their own data even if healthMetrics
// gets turned off, so a consent/record is never permanently stranded.
router.delete('/me', requireAuth, consentCtrl.deleteAllMyData);

// ---- Admin (gobhi) — aggregate only, no per-user drill-down, per the
// customer-only visibility decision in the implementation plan -----------
router.get('/admin/adoption-summary', requireRole('gobhi'), adminCtrl.getAdoptionSummary);
// Whether the readiness suggestions are landing at all (GS-5) — aggregate
// counts only, no per-user rows.
router.get('/admin/suggestion-feedback', requireRole('gobhi'), suggestionFeedbackCtrl.getFeedbackStats);

// ---- Unlogged attendance (FR-03) + nudges (FR-08) -----------------------
// "You were at the gym and haven't said what you did" - the read that turns
// the attendance attachment into a prompt.
router.get('/unlogged', ...gated, nudgeCtrl.getUnlogged);
router.get('/nudges', ...gated, nudgeCtrl.getNudgeSettings);
router.put('/nudges', ...gated, nudgeCtrl.updateNudgeSettings);

// ---- Progress stats (FR-06) ---------------------------------------------
// Everything the Progress screen draws, in one request, computed from the
// same range builder the export uses so the two can never disagree.
router.get('/stats', ...gated, statsCtrl.getStats);

// ---- Weekly goal (FR-04) -------------------------------------------------
// Progress comes back with the target: one response backs the whole ring, so
// the client never derives "this week" itself and can't disagree with the
// streak week challenge-service keeps.
router.get('/goal', ...gated, goalCtrl.getGoal);
router.put('/goal', ...gated, goalCtrl.updateGoal);

// ---- Retention policy (DPDPA purpose limitation) ------------------------
// Customer-readable copy of the policy, for the in-app "what we keep and for
// how long" screen (Health+ FR-06). Same flag gate as the rest of the health
// surface — the screen only exists inside that section.
router.get('/retention-policy', ...gated, retentionCtrl.getMyRetentionPolicy);
// Admin-editable so a period can change on legal advice without a redeploy.
router.get('/admin/retention-policy', requireRole('gobhi'), retentionCtrl.getRetentionPolicy);
router.put('/admin/retention-policy', requireRole('gobhi'), retentionCtrl.updateRetentionPolicy);
// Run by a scheduled workflow, same pattern as the Razorpay reconcile sweep.
// Deliberately NOT flag-gated: purpose limitation is an obligation, not a
// feature, so it must keep running whatever else is switched off.
router.post('/internal/retention/sweep', requireInternal, retentionCtrl.runRetentionSweepInternal);
// Nudge sweep, run by a scheduled workflow. NOT flag-gated on healthMetrics
// at the route: the sweep's own candidate queries return nothing while the
// feature is off, and a 403 here would make a broken cron look like a quiet
// one in the CI log.
router.post('/internal/nudges/sweep', requireInternal, nudgeCtrl.runNudgeSweepInternal);

export default router;
