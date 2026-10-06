import { Router } from 'express';
import { requireAuth, requireRole, requireInternal } from '../middleware/requireAuth.js';
import { requireFeatureFlag, requireAnyFeatureFlag } from '../middleware/requireFeatureFlag.js';
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
import * as insurerGradeCtrl from '../controllers/insurerGradeController.js';
import * as goalCtrl from '../controllers/goalController.js';
import * as consistencyStreakCtrl from '../controllers/consistencyStreakController.js';
import * as planCtrl from '../controllers/planController.js';
import * as statsCtrl from '../controllers/statsController.js';
import * as nudgeCtrl from '../controllers/nudgeController.js';
import * as assistantCtrl from '../controllers/assistantController.js';
import * as cycleCtrl from '../controllers/cycleTrackingController.js';
import { requireCycleConsent } from '../middleware/requireCycleConsent.js';
import * as locationRoutesCtrl from '../controllers/locationRoutesController.js';
import { requireLocationRoutesConsent } from '../middleware/requireLocationRoutesConsent.js';
import { requireAssistantConsent } from '../middleware/requireAssistantConsent.js';
import { requireDeviceHealthConsent } from '../middleware/requireDeviceHealthConsent.js';
import { requireBiometricWriteConsent } from '../middleware/requireBiometricConsent.js';
import * as biometricConsentCtrl from '../controllers/biometricConsentController.js';
import * as healthProfileCtrl from '../controllers/healthProfileController.js';
import * as reportCtrl from '../controllers/reportController.js';
import { uploadHealthReportMiddleware } from '../middleware/medicalUpload.js';
// Adults-only on every consent GRANT (never on revoke/delete) — see requireAdult.
import { requireAdult } from '../middleware/requireAdult.js';
import * as recapCtrl from '../controllers/recapController.js';
import * as retentionCtrl from '../controllers/retentionController.js';
import * as adminCtrl from '../controllers/adminController.js';
import * as runCtrl from '../controllers/runController.js';
import * as ledgerCtrl from '../controllers/ledgerController.js';
// The health ledger (nutrition, plan, score, medical documents) lives in its
// own router because it needs a different gate shape: three layers rather than
// one, and two distinct per-person consent scopes. Mixing those into `gated`
// here would mean every ledger route inherited healthMetrics alone.
import ledgerRouter from './ledger.js';

const router = Router();

// Mounted, not spread. The ledger carries its own requireAuth, its own flag
// checks and its own consent middlewares, and they have to run in that order.
router.use(ledgerRouter);

// Every customer-facing route is server-side gated, not just client-hidden —
// same posture challenge-service takes with streaksCoins, and more important
// here since these features collect new personal (and DPDP-sensitive) data.
//
// Three gate shapes, split on 2026-10-04 when the single `healthMetrics`
// boolean was split into a standalone workout log and a narrowed score layer:
//
//   workoutGated  → `workoutTracking`  exercise library, routines, sessions,
//                   sets, quick logging, progress, readiness, plans, the
//                   post-check-in prompt. The high-frequency daily loop, and the
//                   half that had no business being switched off by a health
//                   feature decision.
//   metricsGated  → `healthMetrics`    health score, biomarkers, health profile,
//                   data export. The derived-score half.
//   vaultGated    → `healthVault`      Local Health Vault (report upload/verify).
//
// The transitional `either` gate below is NOT a third permanent shape — see
// requireAnyFeatureFlag for why it exists and when it goes away.
const workoutGated = [
  requireAuth,
  requireAnyFeatureFlag('workoutTracking', 'healthMetrics'),
];
// `metricsGated` requires `healthMetrics` alone, NOT `healthMetrics` AND
// `workoutTracking` — even though the registry declares healthMetrics as
// depending on workoutTracking, and even though the Flutter client composes
// both (AppConfigStore.healthMetricsVisible). This asymmetry is deliberate and
// temporary, and it is the transitional either-gate argued in
// requireAnyFeatureFlag: requiring workoutTracking here would resolve false on
// any config blob written before the split, because a stored blob only contains
// keys an admin has actually saved. That would 403 every score/biometric route
// in dev the moment this deploys, before the backfill has run.
//
// Read this as "the dependency is not yet enforced server-side", not as "the
// dependency was dropped". It becomes enforced by tightening this array to
// [requireAuth, requireFeatureFlag('workoutTracking'), requireFeatureFlag('healthMetrics')]
// at backfill time — the same commit that removes requireAnyFeatureFlag. The
// routeSplitGates test below pins the current shape so the tightening is a
// deliberate diff rather than something nobody notices.
const metricsGated = [requireAuth, requireFeatureFlag('healthMetrics')];

// Local Health Vault (PDF Reports). Was inherited from `healthMetrics`, which
// meant the most consent-sensitive surface in the app was switched by a boolean
// whose name was about health scores and which also turned on the workout log.
// Standalone now, default off, pending legal sign-off — see the registry.
//
// Deliberately NOT dependent on healthMetrics or workoutTracking: a user who
// uploaded a report while the vault was on must be able to reach it to read,
// verify or erase it after it is switched off. Same rule as DELETE /me and the
// /runs/consent delete — a consent record or extracted biomarker may never be
// stranded behind a feature switch. That is also why this is not gated on
// `workoutTracking` the way the registry's own dependency note would suggest:
// the vault collects its own data and depends on nothing.
const vaultGated = [requireAuth, requireFeatureFlag('healthVault')];
router.post(
  '/reports/upload',
  ...vaultGated,
  uploadHealthReportMiddleware,
  reportCtrl.uploadReport,
);
router.get('/reports', ...vaultGated, reportCtrl.listReports);
router.get('/reports/pending', ...vaultGated, reportCtrl.getPendingExtractions);
router.post('/reports/verify', ...vaultGated, reportCtrl.verifyExtraction);
// requireAuth alone, deliberately NOT vaultGated — see the vaultGated comment
// above, and test/routeSplitGates.test.js which enforces it. A lab report is
// the most sensitive thing this service holds; being unable to erase one
// because a feature switch is off would be the worst version of this feature,
// and the switch is not the user's to control.
router.delete('/reports/:id', requireAuth, reportCtrl.deleteReport);

// Consent is the one surface BOTH halves legitimately need: the device-health
// scope backs workout activity sync, the body-numbers scope backs biometrics.
// Gating it on a single half would have locked one side out of its own consent
// record, so it takes the transitional either-gate until the backfill.
const consentGated = [
  requireAuth,
  requireAnyFeatureFlag('workoutTracking', 'healthMetrics'),
];

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

// The fitness assistant, layered the same way — its own flag ON TOP of
// healthMetrics, because it needs its own sign-off (an AI answering questions
// about someone's body is a bigger claim than logging their sets) and because
// it should be switchable off independently of the workout logging it reads.
//
// Consent is a SEPARATE middleware from the flag, and only on the routes that
// actually talk to the model: the flag answers "does this feature exist",
// consent answers "has this person agreed to it", and they fail differently
// (403 FEATURE_DISABLED vs a prompt the UI can act on). Reading consent or
// granting it must stay reachable without already having it, or there is no
// way in.
const assistantGated = [
  requireAuth,
  requireFeatureFlag('healthMetrics'),
  requireFeatureFlag('fitnessAssistant'),
];

// GPS run tracker (run-tracker-spec.html §12 Q1: recommended to depend on
// healthMetrics — reuses its consent/storage/export/erase plumbing and
// ships dark alongside the rest of Health+ rather than needing its own
// legal sign-off). Layered the same way as fitnessAssistant/cycleTracking:
// its own flag ON TOP of healthMetrics, independently switchable.
const runTrackerGated = [
  requireAuth,
  requireFeatureFlag('healthMetrics'),
  requireFeatureFlag('runTracker'),
];

// ---- Cycle tracking ------------------------------------------------------
// Two independent gates, and they fail differently on purpose. The FLAG says
// whether the feature exists at all (403 FEATURE_DISABLED); the CONSENT SCOPE
// says whether this user opted in, and its absence is a prompt the UI can act
// on rather than an error. Reading the profile and granting consent must stay
// reachable without already having consent, or there is no way to opt in.
const cycleGated = [
  requireAuth,
  requireFeatureFlag('healthMetrics'),
  requireFeatureFlag('cycleTracking'),
];
router.get('/cycle', ...cycleGated, cycleCtrl.getProfile);
router.post('/cycle/consent', ...cycleGated, requireAdult, cycleCtrl.grantConsent);
router.delete('/cycle/consent', ...cycleGated, cycleCtrl.revokeConsent);
router.put('/cycle', ...cycleGated, requireCycleConsent, cycleCtrl.updateProfile);
router.get('/cycle/phases', ...cycleGated, requireCycleConsent, cycleCtrl.listPhases);
router.post('/cycle/phases', ...cycleGated, requireCycleConsent, cycleCtrl.logPhase);
// NOT flag-gated, same reasoning as DELETE /me: a user must always be able to
// delete their own data, even if the feature that collected it is switched off.
router.delete('/cycle', requireAuth, cycleCtrl.deleteAllData);

// ---- Fitness assistant ---------------------------------------------------
router.get('/assistant/consent', ...assistantGated, assistantCtrl.getConsent);
router.post('/assistant/consent', ...assistantGated, requireAdult, assistantCtrl.grantConsent);
router.delete('/assistant/consent', ...assistantGated, assistantCtrl.revokeConsent);
router.get('/assistant/conversations', ...assistantGated, requireAssistantConsent, assistantCtrl.listConversations);
router.post('/assistant/messages', ...assistantGated, requireAssistantConsent, assistantCtrl.sendMessage);
// MUST stay below /assistant/conversations above — otherwise ":id" swallows
// "conversations" on the collection route. Same one-path-segment footgun this
// repo hits in gym-service's routes.
router.get('/assistant/conversations/:id', ...assistantGated, requireAssistantConsent, assistantCtrl.getConversation);
router.delete('/assistant/conversations/:id', ...assistantGated, assistantCtrl.deleteConversation);

// What the coach has learned about this user. Consent-gated like the chat
// itself for reads and writes - but NOT for the delete, on the same reasoning
// as the DPDPA erasure routes above: withdrawing consent must never be the
// thing that strands data a user wants removed.
router.get('/assistant/memories', ...assistantGated, requireAssistantConsent, assistantCtrl.listMemories);
router.put('/assistant/memories', ...assistantGated, requireAssistantConsent, assistantCtrl.confirmMemory);
router.delete('/assistant/memories/:id', ...assistantGated, assistantCtrl.forgetMemory);

// ---- Consent -------------------------------------------------------------
router.post('/consent', ...consentGated, requireAdult, consentCtrl.grantConsent);
router.delete('/consent', ...consentGated, consentCtrl.revokeConsent);
router.get('/consent/status', ...consentGated, consentCtrl.getConsentStatus);

// ---- Exercise library ------------------------------------------------
router.get('/exercises', ...workoutGated, exerciseCtrl.searchExercises);
router.post('/exercises', ...workoutGated, exerciseCtrl.createCustomExercise);
router.get('/exercises/:id', ...workoutGated, exerciseCtrl.getExerciseDetail);
router.get('/exercises/:id/history', ...workoutGated, exerciseCtrl.getExerciseHistory);

// ---- Routines (templates) ---------------------------------------------
router.get('/templates', ...workoutGated, templateCtrl.listTemplates);
router.post('/templates', ...workoutGated, templateCtrl.createTemplate);
router.put('/templates/:id', ...workoutGated, templateCtrl.updateTemplate);
router.delete('/templates/:id', ...workoutGated, templateCtrl.deleteTemplate);

// ---- Workout sessions ---------------------------------------------------
router.post('/sessions', ...workoutGated, sessionCtrl.startSession);
router.get('/sessions', ...workoutGated, sessionCtrl.listSessions);
// Must be registered before /sessions/:id — otherwise "today" is parsed as
// the :id param (same route-ordering footgun the app.js /health comment
// already calls out for this service).
router.get('/sessions/today', ...workoutGated, sessionCtrl.getTodaySession);
router.get('/sessions/:id', ...workoutGated, sessionCtrl.getSessionDetail);
router.patch('/sessions/:id/sets/:setId', ...workoutGated, sessionCtrl.updateSet);
router.post('/sessions/:id/exercises', ...workoutGated, sessionCtrl.addExerciseToSession);
router.post('/sessions/:id/exercises/:sessionExerciseId/sets', ...workoutGated, sessionCtrl.addSetToExercise);
// Finishing a session is what triggers the gamified-layer coin check (see
// sessionController.finishSession) — kept as one PATCH rather than a
// separate /finish route, since "set endedAt" is the only state transition
// that matters here.
router.patch('/sessions/:id', ...workoutGated, sessionCtrl.finishSession);

// ---- Cardio/yoga/other quick logging + device-synced activity ---------
router.post('/exercise-records', ...workoutGated, activityCtrl.createExerciseRecord);
router.get('/exercise-records', ...workoutGated, activityCtrl.listExerciseRecords);
// Device sync alone is consent-gated server-side: it is the one write whose
// data comes from HealthKit/Health Connect rather than from the person typing
// it, and the OS permission can outlive a revoked in-app consent. See
// requireDeviceHealthConsent for why exercise-records (manual + device mixed)
// is not gated the same way.
router.post('/daily-activity/sync', ...workoutGated, requireDeviceHealthConsent, activityCtrl.syncDailyActivity);
router.get('/daily-activity', ...workoutGated, activityCtrl.getDailyActivity);

// ---- GPS run tracker (run-tracker-spec.html §10) -------------------------
// Two independent gates, mirroring cycle tracking above. The FLAG says whether
// the feature exists (403 FEATURE_DISABLED); the `location_routes` CONSENT SCOPE
// says whether this user agreed to their precise location being stored. A run
// is a precise location history and most runs start and end at home, so this
// scope is separate from cycle_tracking and separately withdrawable.
//
// Reading consent and granting it stay reachable WITHOUT the scope, or there
// would be no way to opt in. Everything that touches recorded route data
// requires it.
router.get('/runs/consent', ...runTrackerGated, locationRoutesCtrl.getConsent);
router.post('/runs/consent', ...runTrackerGated, requireAdult, locationRoutesCtrl.grantConsent);
router.delete('/runs/consent', requireAuth, locationRoutesCtrl.revokeConsent);

// Order matters: /runs/summary must be registered before /runs/:id, or
// "summary" is parsed as the :id param — same footgun /sessions/today
// above and gym-service's /health route ordering call out.
router.post('/runs', ...runTrackerGated, requireLocationRoutesConsent, runCtrl.createRun);
router.get('/runs', ...runTrackerGated, requireLocationRoutesConsent, runCtrl.listRuns);
router.get('/runs/summary', ...runTrackerGated, requireLocationRoutesConsent, runCtrl.getRunSummary);
router.get('/runs/:id', ...runTrackerGated, requireLocationRoutesConsent, runCtrl.getRunDetail);
// Deletion is deliberately NOT flag-gated beyond requireAuth, same as
// DELETE /biometrics/:metric/:localDate and DELETE /me: a user must always
// be able to remove their own data even if runTracker gets switched off.
router.delete('/runs/:id', requireAuth, runCtrl.deleteRun);

// ---- Progress -------------------------------------------------------------
// Both endpoints are computed from logged sessions, so both belong to the
// workout half — muscle readiness in particular is meaningless without them.
router.get('/progress/summary', ...workoutGated, progressCtrl.getProgressSummary);
router.get('/progress/muscle-readiness', ...workoutGated, progressCtrl.getMuscleReadiness);

// ---- Biometric entries (Fitness+ FR-12 + Health+ FR-01) -----------------
// One table, one set of endpoints for both: Fitness+ surfaces weight and
// body_fat ("Track body"), Health+ Phase 1 adds resting HR / sleep / steps /
// HRV / stress on the same schema, wearable-ready. POST accepts either a
// single {metric,value} or {entries:[...]} for the multi-metric quick-add.
// Typed body numbers need their own consent (body_numbers), separate from the
// device-access HealthConsent - see biometricConsentService.js. Only the WRITE
// is gated: reading, exporting and deleting what is already logged never
// depends on agreeing to log more. The consent routes are registered first and
// are themselves ungated by the scope, or there would be no way to opt in.
// Revoke is requireAuth only, like /runs/consent: withdrawing must keep working
// even if the healthMetrics flag is switched off.
router.get('/biometrics/consent', ...metricsGated, biometricConsentCtrl.getConsent);
router.post('/biometrics/consent', ...metricsGated, requireAdult, biometricConsentCtrl.grantConsent);
router.delete('/biometrics/consent', requireAuth, biometricConsentCtrl.revokeConsent);
router.post('/biometrics', ...metricsGated, requireBiometricWriteConsent, biometricCtrl.upsertEntries);
router.get('/biometrics', ...metricsGated, biometricCtrl.listEntries);
// Must precede the :metric route below so "latest" isn't parsed as a metric.
router.get('/biometrics/latest', ...metricsGated, biometricCtrl.getLatest);
router.delete('/biometrics/:metric/:localDate', ...metricsGated, biometricCtrl.deleteEntry);

// ---- Suggestion feedback (FR-15) ----------------------------------------
// The impression POST fires when a suggestion is shown, the vote PATCH when
// the user reacts to it — both halves are needed for GS-5 to mean anything.
// Suggestions are derived from the training log, so this follows the workout
// half rather than the score layer.
router.post('/suggestions/impressions', ...workoutGated, suggestionFeedbackCtrl.recordImpression);
router.patch('/suggestions/impressions/:id/vote', ...workoutGated, suggestionFeedbackCtrl.recordVote);

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

// ---- Health profile (gamified onboarding v2, 2026-10-01) ------------------
//
// Gated on brandedOnboarding, NOT healthMetrics: these questions are asked at
// signup, which runs for every new user, and prod has healthMetrics off. The
// flag gates WRITES only. Reading, deleting and withdrawing consent stay open
// to anyone signed in, whatever the flags say — seeing and erasing your own
// answers can never depend on a feature switch.
const profileWrite = [requireAuth, requireFeatureFlag('brandedOnboarding')];
router.get('/health-profile', requireAuth, healthProfileCtrl.getProfile);
router.patch('/health-profile', ...profileWrite, healthProfileCtrl.updateProfile);
router.delete('/health-profile', requireAuth, healthProfileCtrl.deleteProfile);
router.get('/health-profile/consent', requireAuth, healthProfileCtrl.getConsent);
router.post('/health-profile/consent', ...profileWrite, requireAdult, healthProfileCtrl.grantConsent);
router.delete('/health-profile/consent', requireAuth, healthProfileCtrl.revokeConsent);
router.get('/health-profile/medications', requireAuth, healthProfileCtrl.listMedications);
router.post('/health-profile/medications', ...profileWrite, healthProfileCtrl.createMedication);
router.patch('/health-profile/medications/:id', ...profileWrite, healthProfileCtrl.updateMedication);
router.delete('/health-profile/medications/:id', requireAuth, healthProfileCtrl.deleteMedication);

// ---- Data export (FR-16) ------------------------------------------------
// Takes the transitional either-gate rather than metricsGated on purpose: this
// is the DPDPA access right over the WHOLE health surface, and after the split
// a user can have workout sessions logged with healthMetrics off. Gating export
// on the score layer alone would strand exactly that user's own data behind a
// switch they cannot reach — an access right that fails closed on a feature
// flag is not an access right. Narrowing to workoutGated instead would have
// hidden biomarker rows from a user who still has them.
const exportGated = [
  requireAuth,
  requireAnyFeatureFlag('workoutTracking', 'healthMetrics'),
];
router.get('/export', ...exportGated, exportCtrl.exportMyData);
// The user's own insurer-grade adherence summary (ig-v1) for a date range: the
// preview of exactly what a future insurer share would contain. Gym attendance
// and manual logs only - never device health data - so it belongs with the
// workout half. Read-only; nothing is sent anywhere. Plus the ledger checks
// inside the controller for the plan-tick part.
router.get('/insurer-grade', ...workoutGated, insurerGradeCtrl.getMyInsurerGrade);

// Internal — booking-service fires this on every verified check-in
// (self-checkin, partner-verify, manual-override, member-checkin), same
// fan-out that already feeds challenge-service's /internal/attendance-events.
// Not flag-gated at the route level — the handler checks the workout flag
// itself, so booking-service can call this unconditionally and it's inert
// until an admin turns workout tracking on.
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
// Multi-user daily-activity feed for booking-service's leaderboard score
// (ids + from/to). Internal only — the public /daily-activity read stays
// strictly per-user.
router.get('/internal/daily-activity', requireInternal, activityCtrl.getDailyActivityInternal);

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
// Reclaims food photos that were uploaded for recognition and never confirmed.
//
// An admin route rather than a scheduled job on purpose: this fleet is Cloud Run
// with min-instances=0 and no cron, so a timer configured in the service would
// be a sweep that silently stops running the first time nothing calls the
// service. Called from outside it runs when it is asked to.
//
// The response is a count, never a path or a userId — this route is the one
// place a gobhi account can reach food-photo storage, and it has no reason to be
// able to name a single photo.
router.post('/admin/food-photos/sweep', requireRole('gobhi'), ledgerCtrl.sweepFoodPhotos);

// The missing-food queue: what people searched for, could not find, and asked
// us to add. Ordered by how many people have asked, which makes it the closest
// thing to a roadmap this service produces on its own.
//
// Scoped as narrowly as the photo sweeper above, for the same class of reason:
// these rows carry free-text names a user typed, so the read returns no userId
// and there is no route that filters by one. A reviewer can see that twenty
// people want omelette; a reviewer cannot see who.
router.get('/admin/food-requests', requireRole('gobhi'), ledgerCtrl.listFoodRequestQueue);
router.post('/admin/food-requests/:id/resolve', requireRole('gobhi'), ledgerCtrl.resolveFoodRequest);

// The one place free-text demand becomes reference data: a gobhi reviewer adds
// a food the queue asked for, with numbers they can source. `createFood`
// re-serves those values straight into the catalogue and closes the pending
// requests for that name - see foodAdminService.js for the boundary.
router.post('/admin/food-items', requireRole('gobhi'), ledgerCtrl.createFoodItem);

// Recompute the embedded catalogue the on-device matcher compares photos
// against (see foodEmbeddingService.js). Runs a batched provider call, not
// per-photo spend; call it after any seed change.
router.post('/admin/food-embeddings/refresh', requireRole('gobhi'), ledgerCtrl.refreshFoodEmbeddings);

// ---- Unlogged attendance (FR-03) + nudges (FR-08) -----------------------
// "You were at the gym and haven't said what you did" - the read that turns
// the attendance attachment into a prompt. Workout half by construction: the
// thing it is prompting for is a logged session.
router.get('/unlogged', ...workoutGated, nudgeCtrl.getUnlogged);
router.get('/nudges', ...workoutGated, nudgeCtrl.getNudgeSettings);
router.put('/nudges', ...workoutGated, nudgeCtrl.updateNudgeSettings);

// ---- Progress stats (FR-06) ---------------------------------------------
// Everything the Progress screen draws, in one request, computed from the
// same range builder the export uses so the two can never disagree.
router.get('/stats', ...workoutGated, statsCtrl.getStats);

// ---- Weekly goal (FR-04) -------------------------------------------------
// Progress comes back with the target: one response backs the whole ring, so
// the client never derives "this week" itself and can't disagree with the
// streak week challenge-service keeps.
router.get('/goal', ...workoutGated, goalCtrl.getGoal);
router.put('/goal', ...workoutGated, goalCtrl.updateGoal);

// ---- Consistency streak (home track, D-01) ------------------------------
// The streak for people who train at home, derived from their own logged
// sessions. Pays no coins and grants no milestone — that stays with
// challenge-service's verified, check-in-backed streak, because a coin
// redeems for a real gym pass and a self-reported log must never mint one.
// Lives here rather than in challenge-service so there is no import path
// from this number to the coin ledger. Derived on read, so there's nothing
// extra to erase or export beyond the sessions it comes from.
router.get('/consistency-streak', ...workoutGated, consistencyStreakCtrl.getConsistencyStreak);

// ---- Multi-week plans (home track, H-21/H-22) ---------------------------
// Free, not sold — see the WorkoutPlan schema comment (D-02). "today"
// before "active" isn't a route-ordering concern here (no :id/:key
// collision), unlike sessions/today above.
router.get('/plans', ...workoutGated, planCtrl.listPlans);
router.get('/plans/active', ...workoutGated, planCtrl.getActivePlan);
router.post('/plans/:key/start', ...workoutGated, planCtrl.startPlan);
router.delete('/plans/active', ...workoutGated, planCtrl.abandonPlan);

// ---- Retention policy (DPDPA purpose limitation) ------------------------
// Customer-readable copy of the policy, for the in-app "what we keep and for
// how long" screen (Health+ FR-06). Gated on the score half, matching where
// the retention obligations themselves are documented.
router.get('/retention-policy', ...metricsGated, retentionCtrl.getMyRetentionPolicy);
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
// Nightly ledger day close (ledger/dayCloseService.runDayCloseSweep). Checks the
// healthMetrics + healthLedger flags itself and is idempotent per user-day, so a
// double run, or a run with the ledger switched off, writes nothing.
router.post('/internal/ledger/close-days', requireInternal, ledgerCtrl.runDayCloseSweepInternal);

export default router;
