import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import * as consentCtrl from '../controllers/consentController.js';
import * as exerciseCtrl from '../controllers/exerciseController.js';
import * as templateCtrl from '../controllers/templateController.js';
import * as sessionCtrl from '../controllers/sessionController.js';
import * as activityCtrl from '../controllers/activityController.js';
import * as progressCtrl from '../controllers/progressController.js';
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

// ---- Account-wide deletion (called by the same flow that deletes the rest
// of a user's account — see auth-service's onDeleteAccount). Deliberately
// NOT flag-gated — same reasoning as challenge-service's refund route: a
// user must always be able to delete their own data even if healthMetrics
// gets turned off, so a consent/record is never permanently stranded.
router.delete('/me', requireAuth, consentCtrl.deleteAllMyData);

// ---- Admin (gobhi) — aggregate only, no per-user drill-down, per the
// customer-only visibility decision in the implementation plan -----------
router.get('/admin/adoption-summary', requireRole('gobhi'), adminCtrl.getAdoptionSummary);

export default router;
