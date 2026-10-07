import { Router } from 'express';
import { requireAuth, requireInternal } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { requireAdult } from '../middleware/requireAdult.js';
import { requireNutritionConsent, requireMedicalRecordsConsent } from '../middleware/requireLedgerConsent.js';
import { requireBiometricConsentForIntakeWeight } from '../middleware/requireBiometricConsent.js';
import * as ledgerCtrl from '../controllers/ledgerController.js';
import * as ledgerConsentCtrl from '../controllers/ledgerConsentController.js';
import * as appointmentCtrl from '../controllers/appointmentController.js';
import { uploadMedicalDocumentMiddleware } from '../middleware/medicalUpload.js';
import { uploadFoodPhotoMiddleware } from '../middleware/foodPhotoUpload.js';

const router = Router();

// ---- Gating ---------------------------------------------------------------
//
// Three layers, each answering a different question:
//
//   healthLedger flag   - does this feature exist? Admin-controlled, default
//                         off. A 403 FEATURE_DISABLED, which the app treats as
//                         "not in this build".
//   healthMetrics flag  - is the surrounding health surface on at all? The
//                         ledger stores weight, food and prescriptions, so it
//                         must not be reachable while the rest of Health+ is
//                         switched off.
//   consent scope       - has THIS person agreed to nutrition / medical
//                         records? A 403 CONSENT_REQUIRED, which the app turns
//                         into an opt-in prompt. Not a flag: consent is
//                         per-person and revocable at any time.
//
// Consent has to be inside the gate on the routes that read the data, and
// deliberately NOT on the routes that read or grant consent itself - otherwise
// there is no way to opt in.
const ledgerGated = [requireAuth, requireFeatureFlag('healthMetrics'), requireFeatureFlag('healthLedger')];

const nutrition = [...ledgerGated, requireNutritionConsent];
const medical = [...ledgerGated, requireMedicalRecordsConsent];

// Consent status and granting are reachable with the flag on but without the
// scope already granted.
const consentGated = [...ledgerGated];

// ---- Consent --------------------------------------------------------------

router.get('/ledger/consent', ...consentGated, ledgerConsentCtrl.getConsent);
// Current policy wording version on its own, so the app can render the prompt
// before it has any consent state to show. Public within the ledger gate —
// there is nothing user-specific in it.
router.get('/ledger/consent/policy', ...consentGated, ledgerConsentCtrl.getPolicy);
router.post('/ledger/consent/nutrition', ...consentGated, requireAdult, ledgerConsentCtrl.grantNutrition);
router.delete('/ledger/consent/nutrition', ...consentGated, ledgerConsentCtrl.revokeNutrition);
router.post('/ledger/consent/medical-records', ...consentGated, requireAdult, ledgerConsentCtrl.grantMedicalRecords);
router.delete('/ledger/consent/medical-records', ...consentGated, ledgerConsentCtrl.revokeMedicalRecords);

// ---- Intake ----------------------------------------------------------------

// Gated on `nutrition` like the target routes, because intake exists to produce
// a nutrition target. This is a deliberate consequence of that: answering "what
// are you working towards, how old are you" is itself health data, and the
// nutrition consent is what the user agreed to when they turned the food log on.
router.get('/ledger/setup', ...nutrition, ledgerCtrl.getSetup);
// A weight in the body is written to the BiometricEntry series (source
// 'manual'), so it also needs body-numbers consent - nutrition consent describes
// the food log, not body measurements. A save without a weight is unaffected.
router.put('/ledger/setup', ...nutrition, requireBiometricConsentForIntakeWeight, ledgerCtrl.saveSetup);

// ---- Targets --------------------------------------------------------------

router.get('/ledger/targets', ...nutrition, ledgerCtrl.getTargets);
router.post('/ledger/targets/recompute', ...nutrition, ledgerCtrl.recomputeTargets);
// GET, and not a second POST, because this reads. It was previously served by
// calling the recompute endpoint, which turned a screen load into a write.
router.get(
  '/ledger/targets/activity-detail',
  ...nutrition,
  ledgerCtrl.getTargetActivityDetail
);

// ---- Food -----------------------------------------------------------------

// includeUnverified defaults to true here. See the comment on searchFoods: the
// catalogue ships unverified pending nutritionist sign-off, and the alternative
// is a food log with nothing in it.
router.get('/ledger/foods', ...nutrition, ledgerCtrl.searchFoods);
// The empty state's escape hatch. Same gate as search itself, for the same
// reason: it lives inside the picker, so a user who cannot reach the picker
// cannot reach this.
router.post('/ledger/food-requests', ...nutrition, ledgerCtrl.requestFood);
router.get('/ledger/food-requests', ...nutrition, ledgerCtrl.listFoodRequests);
// The embedded catalogue for the on-device matcher. Nutrition-gated like the
// rest of the ledger: the vectors are derived from catalogue text and carry no
// user data, but they exist to serve this app's food features, so they share
// the ledger's consent gate rather than inventing their own surface.
router.get('/ledger/food-embeddings', ...nutrition, ledgerCtrl.getFoodEmbeddings);
router.post('/ledger/food-logs', ...nutrition, ledgerCtrl.logFood);
router.delete('/ledger/food-logs/:id', ...nutrition, ledgerCtrl.deleteFoodLog);
router.get('/ledger/food-totals/:localDate', ...nutrition, ledgerCtrl.getDayTotals);

router.get('/ledger/saved-meals', ...nutrition, ledgerCtrl.listSavedMeals);
router.post('/ledger/saved-meals', ...nutrition, ledgerCtrl.saveMeal);
router.post('/ledger/saved-meals/:id/log', ...nutrition, ledgerCtrl.logSavedMeal);

// ---- Photo food logging ---------------------------------------------------
//
// A fourth gate, on top of the three above, and the only route group in this
// file that needs one.
//
// `foodPhotoLogging` is not a sub-feature of the ledger the way `healthMetrics`
// and `healthLedger` are. Those two say "does this exist"; this one says
// "may this user's image leave our infrastructure". It is a separate flag with
// its own default because the ledger being on says nothing about consent to
// third-party image processing, and a user who is happy to log dal by hand has
// not agreed to a photo of their plate going to a model.
//
// Nutrition consent still applies on top of it. Both gates, in that order, so a
// request is refused on the flag before the bytes are buffered - the multer
// middleware sits after the gates for the same reason it does on the medical
// route.
const photo = [...nutrition, requireFeatureFlag('foodPhotoLogging')];

router.post(
  '/ledger/food-photos/recognize',
  ...photo,
  uploadFoodPhotoMiddleware,
  ledgerCtrl.recognizeFoodPhoto,
);
// The on-device matcher's storage half (foodEmbeddingService.js): store and
// claim a photo that never reaches the vision model. Same gates as recognize -
// the photo still leaves the phone, so the flag and consent that make recognize
// legal apply to it exactly, and the multer still buffers the bytes after them.
router.post(
  '/ledger/food-photos/upload',
  ...photo,
  uploadFoodPhotoMiddleware,
  ledgerCtrl.uploadFoodPhoto,
);
// Not flag-gated on `foodPhotoLogging`. A photo that was confirmed while the
// flag was on has to stay readable after an admin switches it off - and a read
// mints a signed link for an image this service already holds, so it introduces
// no new capability to gate.
router.get('/ledger/food-logs/:id/photo', ...nutrition, ledgerCtrl.getFoodPhotoLink);
router.post('/ledger/food-photos/confirm', ...photo, ledgerCtrl.confirmFoodPhoto);

// ---- Plan -----------------------------------------------------------------

router.get('/ledger/plan/:localDate', ...nutrition, ledgerCtrl.getPlan);
router.post('/ledger/plan/regenerate', ...nutrition, ledgerCtrl.regeneratePlan);
router.post('/ledger/plan/items', ...nutrition, ledgerCtrl.addPlanItem);
router.post('/ledger/plan/items/:id/complete', ...nutrition, ledgerCtrl.completePlanItem);
router.delete('/ledger/plan/items/:id', ...nutrition, ledgerCtrl.deactivatePlanItem);

// ---- Appointments ---------------------------------------------------------
//
// Gated on `nutrition`, like the plan routes, because an appointment is a thing
// the user is being scored on: the ledger holds prescriptions, diagnoses and
// appointments together, and splitting the consent between them would let
// somebody read a user's medical schedule by way of the food log's consent
// scope. That coupling is deliberate and the cost of it is that a person who
// consents to neither cannot use either.
//
// SCORING IS NOT READ FROM HERE. An appointment written through these routes is
// a record of a booking; the score engine still reads PlanItem kind
// doctor_appointment. Nothing in appointmentService writes PlanItem, so these
// routes cannot change a score - deliberately, until the scoring migration has
// rows on both sides to compare. See the header of appointmentService.js.
//
// `:id` is last in each group. Express matches in registration order, so
// '/appointments/next' has to be declared before a route that would treat
// 'next' as an id - otherwise the next-appointment lookup 404s forever against
// an appointment that does not exist.
router.get('/ledger/appointments', ...nutrition, appointmentCtrl.listAppointments);
router.post('/ledger/appointments', ...nutrition, appointmentCtrl.createAppointment);
// Next BEFORE /:id. See above.
router.get('/ledger/appointments/next', ...nutrition, appointmentCtrl.getNextAppointment);
router.get('/ledger/appointments/:id', ...nutrition, appointmentCtrl.getAppointment);
router.patch('/ledger/appointments/:id', ...nutrition, appointmentCtrl.updateAppointment);
router.delete('/ledger/appointments/:id', ...nutrition, appointmentCtrl.deleteAppointment);

// ---- Score ----------------------------------------------------------------

router.get('/ledger/score', ...nutrition, ledgerCtrl.getScoreSeries);
router.get('/ledger/score/calm', ...nutrition, ledgerCtrl.getCalmSeries);
router.get('/ledger/score/safety', ...nutrition, ledgerCtrl.getSafetyFlag);
router.put('/ledger/score/calm-mode', ...nutrition, ledgerCtrl.setCalmMode);
router.get('/ledger/score/pause', ...nutrition, ledgerCtrl.getPause);
router.put('/ledger/score/pause', ...nutrition, ledgerCtrl.setPause);
router.delete('/ledger/score/pause', ...nutrition, ledgerCtrl.clearPause);
// Attainment - whether the goal is being met, as distinct from what the day was
// worth. A separate route rather than a field on the score series because it
// answers a different question from different evidence: the score reads
// snapshots, this reads the weight series. A client that could conflate them by
// accident is a client we would rather not ship.
router.get('/ledger/attainment', ...nutrition, ledgerCtrl.getAttainment);
// The score's target: the number the user is aiming at and the window they gave
// themselves. Separate from /ledger/attainment on purpose - attainment reads the
// weight series and answers "is the goal being met", this reads the score chain
// and answers "am I getting to the number I set". Different evidence, different
// question, and a client that could conflate them by accident is a client we
// would rather not ship.
router.get('/ledger/score/target', ...nutrition, ledgerCtrl.getScoreTarget);
router.get('/ledger/score/blended', ...nutrition, ledgerCtrl.getBlendedScore);
router.put('/ledger/score/target', ...nutrition, ledgerCtrl.setScoreTarget);
router.delete('/ledger/score/target', ...nutrition, ledgerCtrl.clearScoreTarget);
router.get('/ledger/score/:localDate/preview', ...nutrition, ledgerCtrl.previewScore);
router.post('/ledger/score/:localDate/close', ...nutrition, ledgerCtrl.closeScoreDay);

// Rewards
router.post('/ledger/rewards/evaluate', ...nutrition, ledgerCtrl.evaluateMyReward);
router.post('/internal/rewards/evaluate', requireInternal, ledgerCtrl.evaluateRewards);

// AI Plans
router.post('/ledger/ai/prescribe', ...nutrition, ledgerCtrl.prescribeAiPlan);
router.get('/ledger/biometrics/trajectory', ...nutrition, ledgerCtrl.getBiomarkerTrajectory);
router.get('/ledger/biometrics/correlation', ...nutrition, ledgerCtrl.getMarkerCorrelation);
router.post('/ledger/biometrics/batch-consistency', ...nutrition, ledgerCtrl.getBatchConsistency);

// ---- The adjustable plan ---------------------------------------------------
//
// "Your plan" on the app: four sliders (kcal, steps, sleep, sessions a week)
// and the whole plan that follows from them.
//
// Nutrition-gated, not medical. Everything here is derived from what the
// person eats and how they train - the same question `/ledger/targets` answers
// - whereas a medical record is a separate consent that must not be required
// to move a calorie slider.
//
// Three routes, one shape. POST for the preview despite it being a read: the
// draft is a body, and the app sends one on every debounced drag. Nothing in
// previewPrescription writes, so it stays callable on every drag without cost.
//
// Declared after `/ledger/score/:localDate/preview` deliberately: the route
// gate tests find a preview route by path, and the first one they find has to
// be the GET they are written to expect.
router.get('/ledger/prescription', ...nutrition, ledgerCtrl.getPrescription);
router.post('/ledger/prescription/preview', ...nutrition, ledgerCtrl.previewPrescription);
router.put('/ledger/prescription', ...nutrition, ledgerCtrl.savePrescription);

// ---- Medical documents ----------------------------------------------------
//
// The only place in this service that stores a medical record. The multer
// middleware runs after the consent gate, so a request without consent is
// rejected before the bytes are read into memory - the order matters, because
// buffering an upload is the expensive part and a user who has not consented
// should not make the server hold their file at all.
router.get('/ledger/medical-documents', ...medical, ledgerCtrl.listMedicalDocuments);
router.post(
  '/ledger/medical-documents',
  ...medical,
  uploadMedicalDocumentMiddleware,
  ledgerCtrl.uploadMedicalDocument,
);
router.get('/ledger/medical-documents/:id/link', ...medical, ledgerCtrl.getMedicalDocumentLink);
router.delete('/ledger/medical-documents/:id', ...medical, ledgerCtrl.deleteMedicalDocument);

export default router;
