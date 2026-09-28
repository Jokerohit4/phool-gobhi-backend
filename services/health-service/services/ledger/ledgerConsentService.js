import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Two consent scopes, deliberately separate from each other and from
// `location_routes`.
//
// The split is not tidiness. A food log is a daily behavioural record that
// feeds a score; a medical record is a diagnosis, a prescription and a lab
// slip. Bundling them would mean the only way to decline storing your lab
// report is to also lose your food log, and the only way to use the food log
// is to hand over your prescriptions. A consent screen that forces that trade
// is a consent screen people click through without reading, which is worse
// than not asking.
//
// Same shape as locationRoutesService.js: the scope lives on the existing
// HealthConsent.scopes array (the field was built for exactly this — "a scope
// is added when the surface needing it ships"), so revoking health consent
// revokes both of these too.
export const NUTRITION_SCOPE = 'nutrition';
export const MEDICAL_RECORDS_SCOPE = 'medical_records';

async function readConsent(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt) return null;
  return consent;
}

async function hasScope(userId, scope) {
  const consent = await readConsent(userId);
  if (!consent) return false;
  return (consent.scopes || []).includes(scope);
}

async function addScope(userId, scope, { privacyVersion } = {}) {
  // Requires live health consent first: the scope lives on that record, so
  // without it there is nowhere to record the grant. This is the same
  // ordering health consent itself requires, and the app walks it in the same
  // order — nutrition consent cannot be granted before device consent.
  const consent = await readConsent(userId);
  if (!consent) {
    throw {
      status: 409,
      error: 'Health consent is required before this can be saved.',
      code: 'HEALTH_CONSENT_REQUIRED',
    };
  }

  const scopes = new Set(consent.scopes || []);
  scopes.add(scope);
  await prisma.healthConsent.update({
    where: { userId },
    data: { scopes: [...scopes] },
  });

  return {
    granted: true,
    grantedAt: consent.grantedAt,
    // The wording the client showed. Falls back to the standing health policy
    // version so the response always carries something auditable, matching
    // how the cycle and location-routes services record their grant.
    privacyVersion: privacyVersion || consent.policyVersion || null,
  };
}

// Withdrawing a scope deletes what the scope collected, and this is the one
// place in health-service where that is true.
//
// The general rule everywhere else is that revoking does NOT delete
// (locationRoutesService says so explicitly): silently destroying someone's
// data on a toggle is not a revoke function's call to make. This is the
// exception, and the reason is that the score is DERIVED from these rows.
// Keeping a food log after the nutrition scope is withdrawn would mean the
// next recompute could still read it and move someone's number — consent
// withdrawn, but the personal data still driving a figure they can see. An
// unbacked score is worse than a deleted one.
//
// What survives is only the frozen ScoreDaySnapshot rows, and only because
// they are a historical statement of a day rather than a record of what was
// eaten: the day statement has to keep working after the log is gone, or
// withdrawing consent would rewrite the past as well as the future. Those
// rows carry no food names and no nutrient values, just points and labels.
// `purge` defaults to FALSE, deliberately.
//
// It used to default to true, on the reasoning that withdrawing consent should
// take the data with it. That is wrong in a way that is not recoverable: a
// bare DELETE on the consent endpoint destroyed every food log, saved meal,
// target and uploaded prescription with nothing asking the user to confirm.
// Someone turning off collection is not necessarily asking to have their
// history destroyed - and for a prescription specifically, it may be the one
// copy they have.
//
// Withdrawing consent always stops collection either way. Deleting what is
// already stored is a separate, explicit request, so the destructive default
// is gone from both here and the controller.
async function removeScope(userId, scope, { purge = false } = {}) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (consent) {
    await prisma.healthConsent.update({
      where: { userId },
      data: {
        scopes: (consent.scopes || []).filter((s) => s !== scope),
      },
    });
  }

  if (purge && scope === NUTRITION_SCOPE) {
    // FK-safe order: SavedMealLine cascades from SavedMeal, so the parent
    // delete is enough. FoodLog.foodItemId is SetNull, and the custom foods
    // themselves go last — a seeded FoodItem belongs to no one, so only the
    // user's own custom rows are deleted here.
    await prisma.$transaction([
      prisma.savedMeal.deleteMany({ where: { userId } }),
      prisma.foodLog.deleteMany({ where: { userId } }),
      prisma.nutritionTarget.deleteMany({ where: { userId } }),
      prisma.foodItem.deleteMany({ where: { createdByUserId: userId } }),
    ]);
  }

  if (purge && scope === MEDICAL_RECORDS_SCOPE) {
    // The objects themselves are best-effort removed: the row is the record
    // and it goes regardless, so an orphaned object with no path back to a
    // user is a lifecycle concern for whoever rotates the bucket rather than
    // a privacy hole. The paths are gathered first precisely so the delete
    // can happen before the rows that name them disappear.
    const docs = await prisma.medicalDocument.findMany({
      where: { userId },
      select: { id: true, storagePath: true },
    });
    await prisma.$transaction([
      prisma.medicalDocument.deleteMany({ where: { userId } }),
      prisma.doctorAppointment.deleteMany({ where: { userId } }),
      prisma.healthCondition.deleteMany({ where: { userId } }),
    ]);
    if (docs.length) {
      // Imported lazily to keep this module free of a hard GCS dependency —
      // a revoke must not fail because a storage SDK is misconfigured, and
      // the rows are already gone by this point regardless.
      const { deleteObjects } = await import('./medicalDocumentStorage.js');
      await deleteObjects(docs.map((d) => d.storagePath)).catch((err) =>
        console.error('[consent] medical object cleanup failed:', err.message),
      );
    }
  }

  return { granted: false, purged: Boolean(purge) };
}

async function readScope(userId, scope, privacyVersion) {
  const consent = await readConsent(userId);
  if (!consent) return { granted: false };
  return {
    granted: (consent.scopes || []).includes(scope),
    grantedAt: consent.grantedAt,
    privacyVersion: privacyVersion || consent.policyVersion || null,
  };
}

export const hasNutritionConsentService = (userId) =>
  hasScope(userId, NUTRITION_SCOPE);
export const hasMedicalRecordsConsentService = (userId) =>
  hasScope(userId, MEDICAL_RECORDS_SCOPE);

export const grantNutritionConsentService = (userId, opts) =>
  addScope(userId, NUTRITION_SCOPE, opts);
export const grantMedicalRecordsConsentService = (userId, opts) =>
  addScope(userId, MEDICAL_RECORDS_SCOPE, opts);

export const revokeNutritionConsentService = (userId, opts) =>
  removeScope(userId, NUTRITION_SCOPE, opts);
export const revokeMedicalRecordsConsentService = (userId, opts) =>
  removeScope(userId, MEDICAL_RECORDS_SCOPE, opts);

export const getNutritionConsentService = (userId, privacyVersion) =>
  readScope(userId, NUTRITION_SCOPE, privacyVersion);
export const getMedicalRecordsConsentService = (userId, privacyVersion) =>
  readScope(userId, MEDICAL_RECORDS_SCOPE, privacyVersion);
