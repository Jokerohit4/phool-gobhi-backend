import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag.js';
import { requireNutritionConsent, requireMedicalRecordsConsent } from '../middleware/requireLedgerConsent.js';
import * as ledgerCtrl from '../controllers/ledgerController.js';
import * as ledgerConsentCtrl from '../controllers/ledgerConsentController.js';
import { uploadMedicalDocumentMiddleware } from '../middleware/medicalUpload.js';

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
router.post('/ledger/consent/nutrition', ...consentGated, ledgerConsentCtrl.grantNutrition);
router.delete('/ledger/consent/nutrition', ...consentGated, ledgerConsentCtrl.revokeNutrition);
router.post('/ledger/consent/medical-records', ...consentGated, ledgerConsentCtrl.grantMedicalRecords);
router.delete('/ledger/consent/medical-records', ...consentGated, ledgerConsentCtrl.revokeMedicalRecords);

// ---- Targets --------------------------------------------------------------

router.get('/ledger/targets', ...nutrition, ledgerCtrl.getTargets);
router.post('/ledger/targets/recompute', ...nutrition, ledgerCtrl.recomputeTargets);

// ---- Food -----------------------------------------------------------------

// includeUnverified defaults to true here. See the comment on searchFoods: the
// catalogue ships unverified pending nutritionist sign-off, and the alternative
// is a food log with nothing in it.
router.get('/ledger/foods', ...nutrition, ledgerCtrl.searchFoods);
router.post('/ledger/food-logs', ...nutrition, ledgerCtrl.logFood);
router.delete('/ledger/food-logs/:id', ...nutrition, ledgerCtrl.deleteFoodLog);
router.get('/ledger/food-totals/:localDate', ...nutrition, ledgerCtrl.getDayTotals);

router.get('/ledger/saved-meals', ...nutrition, ledgerCtrl.listSavedMeals);
router.post('/ledger/saved-meals', ...nutrition, ledgerCtrl.saveMeal);
router.post('/ledger/saved-meals/:id/log', ...nutrition, ledgerCtrl.logSavedMeal);

// ---- Plan -----------------------------------------------------------------

router.get('/ledger/plan/:localDate', ...nutrition, ledgerCtrl.getPlan);
router.post('/ledger/plan/regenerate', ...nutrition, ledgerCtrl.regeneratePlan);
router.post('/ledger/plan/items', ...nutrition, ledgerCtrl.addPlanItem);
router.post('/ledger/plan/items/:id/complete', ...nutrition, ledgerCtrl.completePlanItem);
router.delete('/ledger/plan/items/:id', ...nutrition, ledgerCtrl.deactivatePlanItem);

// ---- Score ----------------------------------------------------------------

router.get('/ledger/score', ...nutrition, ledgerCtrl.getScoreSeries);
router.get('/ledger/score/calm', ...nutrition, ledgerCtrl.getCalmSeries);
router.get('/ledger/score/safety', ...nutrition, ledgerCtrl.getSafetyFlag);
router.put('/ledger/score/calm-mode', ...nutrition, ledgerCtrl.setCalmMode);
router.get('/ledger/score/:localDate/preview', ...nutrition, ledgerCtrl.previewScore);
router.post('/ledger/score/:localDate/close', ...nutrition, ledgerCtrl.closeScoreDay);

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
