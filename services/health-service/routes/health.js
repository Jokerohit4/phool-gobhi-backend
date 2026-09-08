import { Router } from 'express';
import { requireAuth, requireRole, requireInternal } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import * as consentCtrl from '../controllers/consentController.js';
import * as exerciseCtrl from '../controllers/exerciseController.js';
import * as templateCtrl from '../controllers/templateController.js';
import * as sessionCtrl from '../controllers/sessionController.js';
import * as activityCtrl from '../controllers/activityController.js';
import * as progressCtrl from '../controllers/progressController.js';
import * as measurementCtrl from '../controllers/measurementController.js';
import * as personalisationCtrl from '../controllers/personalisationController.js';
import * as suggestionFeedbackCtrl from '../controllers/suggestionFeedbackController.js';
import * as exportCtrl from '../controllers/exportController.js';
import * as adminCtrl from '../controllers/adminController.js';

const router = Router();

// Every customer-facing route is server-side gated on the healthMetrics
// flag, not just client-hidden — same posture challenge-service takes with
// streaksCoins, and more important here since this feature collects new
// personal (and DPDP-sensitive) data.
const gated = [requireAuth, requireFeatureFlag('healthMetrics')];

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

// ---- Body measurements (FR-12) ------------------------------------------
// POST upserts today's row (or an explicit localDate) rather than creating —
// see measurementService for why one row per user-day.
router.post('/measurements', ...gated, measurementCtrl.upsertMeasurement);
router.get('/measurements', ...gated, measurementCtrl.listMeasurements);
router.delete('/measurements/:localDate', ...gated, measurementCtrl.deleteMeasurement);

// ---- Suggestion feedback (FR-15) ----------------------------------------
// The impression POST fires when a suggestion is shown, the vote PATCH when
// the user reacts to it — both halves are needed for GS-5 to mean anything.
router.post('/suggestions/impressions', ...gated, suggestionFeedbackCtrl.recordImpression);
router.patch('/suggestions/impressions/:id/vote', ...gated, suggestionFeedbackCtrl.recordVote);

// ---- Personalisation (FR-25/26/27) --------------------------------------
// GET never 404s — "skipped the whole setup" is a valid state and returns
// the same empty shape, so Settings renders without branching.
router.get('/personalisation', ...gated, personalisationCtrl.getProfile);
router.put('/personalisation', ...gated, personalisationCtrl.updateProfile);
// Separate route because this is the consent-bearing write: switching to a
// personalised mode requires a privacyVersion, switching back to neutral
// never does.
router.put('/personalisation/programming-mode', ...gated, personalisationCtrl.setProgrammingMode);

// ---- Data export (FR-16) ------------------------------------------------
router.get('/export', ...gated, exportCtrl.exportMyData);

// Internal — booking-service fires this on every verified check-in
// (self-checkin, partner-verify, manual-override, member-checkin), same
// fan-out that already feeds challenge-service's /internal/attendance-events.
// Not flag-gated at the route level — the handler checks healthMetrics
// itself, so booking-service can call this unconditionally and it's inert
// until an admin turns the phase on.
router.post('/internal/attendance-events', requireInternal, sessionCtrl.recordAttendanceForWorkoutInternal);

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

export default router;
