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

// The wording currently on the consent screens, and the only value a grant may
// be recorded against.
//
// Bump this whenever the prompt text changes enough that agreeing to the new
// version is a different decision from agreeing to the old one. A pure typo fix
// does not need a bump; describing a new category of data does.
//
// Matches the app's kLedgerPolicyVersion. These are the same fact stated twice
// and they have to agree: the app's copy of the constant describes the text it
// renders, this one decides what may be recorded, and if they drift every grant
// from the newer build is refused with no way for the user to proceed. The date
// is when the copy was written, not when this check was added — the copy has
// not changed, so neither has the version. Adding the check does not retroactively
// make the old wording a new one.
export const LEDGER_POLICY_VERSION = '2026-09-27';

// Reads the per-scope version map, tolerating both shapes Prisma can hand back
// for a Json column and the empty default on rows written before the column
// existed.
function scopeVersionsOf(consent) {
  const raw = consent?.scopeVersions;
  if (!raw) return {};
  // Prisma returns parsed JSON for Json columns on Postgres, but a string is
  // what a raw query or a future driver change would produce, and a
  // JSON.parse crash in a consent check would be a very bad place to find out.
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// True when a scope was granted under wording that is no longer current.
//
// A scope with no recorded version is ALSO stale. Rows predating the column are
// exactly the ones where we cannot prove what the user saw, so the honest
// answer is that they need to agree again — the opposite inference, treating
// them as current, is what lets an unprovable grant stand forever.
export function isScopeStale(consent, scope) {
  return scopeVersionsOf(consent)[scope] !== LEDGER_POLICY_VERSION;
}

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

/// Whether [scope] is granted AND was agreed to under the wording that is
/// current today.
///
/// The gate uses this rather than hasScope. A grant under superseded wording is
/// not consent to what the surface now does, and continuing to collect on the
/// strength of it is the exact failure the version field exists to prevent — so
/// a stale grant has to stop the data, not merely annotate the settings screen.
/// The settings screen can still show it, because telling someone "you agreed
/// to this in March" is informative; writing more rows on that basis is not.
async function hasCurrentScope(userId, scope) {
  const consent = await readConsent(userId);
  if (!consent) return false;
  if (!(consent.scopes || []).includes(scope)) return false;
  return !isScopeStale(consent, scope);
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

  // The client sends the version it rendered. Refusing a mismatch is the whole
  // reason the column exists: it stops a stale app from recording agreement to
  // copy that was never on its screen.
  if (privacyVersion !== LEDGER_POLICY_VERSION) {
    throw {
      status: 409,
      error:
        privacyVersion
          ? `This consent copy has been updated. Please reopen the screen to see the current version (${LEDGER_POLICY_VERSION}).`
          : 'The consent screen did not report which version it displayed. Please reopen it and try again.',
      code: 'LEDGER_POLICY_VERSION_MISMATCH',
      currentVersion: LEDGER_POLICY_VERSION,
    };
  }

  const scopes = new Set(consent.scopes || []);
  scopes.add(scope);
  // Written together with the scope, in one update. Recording the scope without
  // the version is what left this unauditable in the first place: the grant
  // exists, and nothing says which wording it was given under.
  const scopeVersions = { ...scopeVersionsOf(consent), [scope]: privacyVersion };
  await prisma.healthConsent.update({
    where: { userId },
    data: { scopes: [...scopes], scopeVersions },
  });

  return {
    granted: true,
    grantedAt: consent.grantedAt,
    // Echoed from the value now on the row, not from the request, so the
    // response cannot describe a grant that was not written.
    privacyVersion,
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
    // The recorded version goes with the scope. Leaving it behind would make a
    // later re-grant look like it had never needed consent, because the stale
    // check reads this map and would find a current version sitting there for a
    // scope the user had already withdrawn.
    const scopeVersions = { ...scopeVersionsOf(consent) };
    delete scopeVersions[scope];
    await prisma.healthConsent.update({
      where: { userId },
      data: {
        scopes: (consent.scopes || []).filter((s) => s !== scope),
        scopeVersions,
      },
    });
  }

  if (purge && scope === NUTRITION_SCOPE) {
    // The photo paths are read BEFORE the transaction, for the same reason the
    // medical scope reads its document paths first: once the rows are gone
    // nothing knows what the objects were called, and a food photo kept for a
    // user who has just withdrawn consent is a record of their diet that they
    // asked us to stop holding.
    const photos = await prisma.foodLog.findMany({
      where: { userId, photoPath: { not: null } },
      select: { photoPath: true },
      distinct: ['photoPath'],
    });
    // FK-safe order: SavedMealLine cascades from SavedMeal, so the parent
    // delete is enough. FoodLog.foodItemId is SetNull, and the custom foods
    // themselves go last — a seeded FoodItem belongs to no one, so only the
    // user's own custom rows are deleted here.
    await prisma.$transaction([
      prisma.savedMeal.deleteMany({ where: { userId } }),
      prisma.foodLog.deleteMany({ where: { userId } }),
      prisma.nutritionTarget.deleteMany({ where: { userId } }),
      prisma.foodItem.deleteMany({ where: { createdByUserId: userId } }),
      // The request ledger, for the same reason. A row that records "this user
      // sent a photo, this model read it, this is what it cost" is itself a
      // record of the user's food logging habits.
      prisma.foodPhotoRequestLog.deleteMany({ where: { userId } }),
    ]);

    if (photos.length) {
      // Lazily imported for the same reason as the medical cleanup below: a
      // revoke must not fail because a storage SDK is misconfigured, and the
      // rows are already gone by this point either way.
      const { deletePhotos } = await import('./foodPhotoStorage.js');
      await deletePhotos(photos.map((p) => p.photoPath)).catch((err) =>
        console.error('[consent] food photo cleanup failed:', err.message),
      );
    }
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

async function readScope(userId, scope) {
  const consent = await readConsent(userId);
  if (!consent) return { granted: false };
  const recorded = scopeVersionsOf(consent)[scope] ?? null;
  return {
    granted: (consent.scopes || []).includes(scope),
    grantedAt: consent.grantedAt,
    // The version recorded for THIS scope, not the device-level
    // HealthConsent.policyVersion. Those describe different prompts, and
    // reporting the device one here would tell a user their medical-records
    // grant was made under a version from before the medical-records screen
    // existed.
    privacyVersion: recorded,
    // Lets the app re-prompt without a second round trip: a scope can be
    // granted and still need asking again if the wording changed since.
    needsReconsent: isScopeStale(consent, scope),
    // What the gate tells an app whose data request was refused for this scope,
    // so it can offer "update and review" rather than a bare refusal. Distinct
    // from privacyVersion, which describes the wording actually on record.
    currentVersion: LEDGER_POLICY_VERSION,
  };
}

// These two are what the data routes are gated on, and they require the
// wording to be current as well as the scope to be present. Renamed apart from
// hasScope so a future caller asking "has this person ever agreed to this?" gets
// the literal answer rather than the stricter one by accident.
export const hasNutritionConsentService = (userId) =>
  hasCurrentScope(userId, NUTRITION_SCOPE);
export const hasMedicalRecordsConsentService = (userId) =>
  hasCurrentScope(userId, MEDICAL_RECORDS_SCOPE);

// The unqualified question, for callers that want presence alone.
export const hasNutritionScopeService = (userId) =>
  hasScope(userId, NUTRITION_SCOPE);
export const hasMedicalRecordsScopeService = (userId) =>
  hasScope(userId, MEDICAL_RECORDS_SCOPE);

export const grantNutritionConsentService = (userId, opts) =>
  addScope(userId, NUTRITION_SCOPE, opts);
export const grantMedicalRecordsConsentService = (userId, opts) =>
  addScope(userId, MEDICAL_RECORDS_SCOPE, opts);

export const revokeNutritionConsentService = (userId, opts) =>
  removeScope(userId, NUTRITION_SCOPE, opts);
export const revokeMedicalRecordsConsentService = (userId, opts) =>
  removeScope(userId, MEDICAL_RECORDS_SCOPE, opts);

export const getNutritionConsentService = (userId) =>
  readScope(userId, NUTRITION_SCOPE);
export const getMedicalRecordsConsentService = (userId) =>
  readScope(userId, MEDICAL_RECORDS_SCOPE);
export { LEDGER_POLICY_VERSION as CURRENT_LEDGER_POLICY_VERSION };
