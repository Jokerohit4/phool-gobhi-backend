import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCoachJourney } from '../middleware/requireCoachJourney.js';
import { requireCoachConsent } from '../middleware/requireCoachConsent.js';
import * as habitsCtrl from '../controllers/habitsController.js';

// The daily habits (water, supplements) — B11. Empty on purpose until B11:
// A2 landed the mount point so the routes could be added without touching
// health.js again.
//
// Two gate shapes, and the split is the point:
//
//   coachBasic       the coachJourney flag + the coach `basic` scope. Water
//                    is layer-1 of the journey — it is the habit everyone
//                    gets at start, so it needs nothing beyond the consent
//                    the whole plan already hangs off.
//   coachSupplements coachBasic PLUS the `supplements` scope. A schedule of
//                    things a person puts in their body is the narrow extra
//                    consent the Contracts keep separate on purpose: agreeing
//                    the coach may build a plan says nothing about tracking
//                    supplements, so these five routes answer 403
//                    CONSENT_REQUIRED until that scope was granted too.
//
// No anyOf here, unlike the ledger's plan/score routes: the habits surface is
// new with the journey, so there is no pre-existing nutrition-consent path
// to keep alive, and a second gate would only widen who can write a log.
const router = Router();

const coachBasic = [requireAuth, requireCoachJourney, requireCoachConsent('basic')];
const coachSupplements = [...coachBasic, requireCoachConsent('supplements')];

router.get('/habits/today', ...coachBasic, habitsCtrl.getToday);

router.post('/habits/rewards/retry', ...coachBasic, habitsCtrl.retryRoutineRewards);
router.post('/habits/water', ...coachBasic, habitsCtrl.logWater);
router.delete('/habits/water/:id', ...coachBasic, habitsCtrl.deleteWaterLog);

router.get('/habits/supplements', ...coachSupplements, habitsCtrl.listSupplements);
router.post('/habits/supplements', ...coachSupplements, habitsCtrl.createSupplement);
router.put('/habits/supplements/:id', ...coachSupplements, habitsCtrl.updateSupplement);
router.delete('/habits/supplements/:id', ...coachSupplements, habitsCtrl.deleteSupplement);
// Must be below the collection route above — otherwise ":id" is never the
// problem here ("taken" is a distinct path segment), but the pairing is kept
// in the same order the sessions/conversations routes pin, so the set reads
// the same way everywhere.
router.post('/habits/supplements/:id/taken', ...coachSupplements, habitsCtrl.markTaken);

export default router;
