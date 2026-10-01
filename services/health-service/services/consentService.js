import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// The consent record that gates the OS-level HealthKit/Health Connect
// permission prompt — a fresh grant always overwrites revokedAt/policyVersion
// rather than requiring a separate "re-grant" path, since re-consenting after
// a revoke is just a grant with history.
export async function grantConsentService(userId, { policyVersion, platform }) {
  if (!policyVersion || !platform) {
    const err = new Error('policyVersion and platform are required');
    err.status = 400;
    throw err;
  }
  if (!['ios', 'android'].includes(platform)) {
    const err = new Error('platform must be ios or android');
    err.status = 400;
    throw err;
  }
  return prisma.healthConsent.upsert({
    where: { userId },
    update: { grantedAt: new Date(), revokedAt: null, policyVersion, platform },
    create: { userId, grantedAt: new Date(), policyVersion, platform },
  });
}

export async function revokeConsentService(userId) {
  const existing = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!existing) {
    const err = new Error('No consent on record');
    err.status = 404;
    throw err;
  }
  return prisma.healthConsent.update({
    where: { userId },
    data: { revokedAt: new Date() },
  });
}

export async function getConsentStatusService(userId) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent) return { granted: false };
  return {
    granted: !consent.revokedAt,
    grantedAt: consent.grantedAt,
    revokedAt: consent.revokedAt,
    policyVersion: consent.policyVersion,
    platform: consent.platform,
  };
}

// Full wipe for this user, called both by the in-app "Revoke & delete" flow
// and by the account-deletion flow elsewhere in the platform. Deletes in
// FK-safe order; WorkoutSession -> SessionExercise -> WorkoutSet and
// WorkoutTemplate -> TemplateExercise cascade automatically (onDelete:
// Cascade in the schema), so only the top-level rows need explicit deletes.
// Custom exercises the user created are deleted too — their personal data,
// not the seeded shared library.
export async function deleteAllDataService(userId) {
  await prisma.$transaction([    prisma.workoutSession.deleteMany({ where: { userId } }),
    prisma.workoutTemplate.deleteMany({ where: { userId } }),
    prisma.exercise.deleteMany({ where: { createdByUserId: userId } }),
    prisma.exerciseRecord.deleteMany({ where: { userId } }),
    prisma.dailyActivityMetric.deleteMany({ where: { userId } }),
    // Biometric entries (weight/body-fat today, resting HR/sleep/HRV once
    // Health+ Phase 1 lands) are among the most sensitive rows here, so they
    // must never outlive the account (the BRD's 30-day erasure line).
    prisma.biometricEntry.deleteMany({ where: { userId } }),
    // Suggestion impressions/votes are per-user behavioural data — the
    // aggregate GS-5 numbers are recomputed from what remains, never
    // retained per-user after deletion.
    prisma.suggestionFeedback.deleteMany({ where: { userId } }),
    // Personalisation (height/weight/injury zones/programming mode) goes
    // with the account too — including the consent record itself.
    prisma.personalisationProfile.deleteMany({ where: { userId } }),
    // The weekly training target is the user's own preference, so it goes
    // with the account like the rest of their record.
    prisma.weeklyGoal.deleteMany({ where: { userId } }),
    // Which multi-week plan a user is on — a preference row, not a record
    // of anything they did (the sessions they actually logged are already
    // covered by the WorkoutSession delete above and survive independently
    // of whether a plan pointed at them).
    prisma.userActivePlan.deleteMany({ where: { userId } }),
    // Nudge suppression and the send log: per-user behavioural rows with
    // no purpose once the account is gone.
    prisma.nudgeOptOut.deleteMany({ where: { userId } }),
    prisma.nudgeLog.deleteMany({ where: { userId } }),
    // NOT deleted here: HealthDataAuditLog. It is the record of who touched
    // this person's health data, which is precisely the thing an erasure
    // request may later need to be evidenced against - deleting the audit
    // trail as part of the erasure would erase the proof the erasure
    // happened. It carries no health values by construction (actor, action,
    // data class, timestamp), and its userId stops resolving to a person
    // once auth-service's User row is gone. Same reasoning the financial
    // records in wallet/booking-service already rely on; see the
    // three-bucket note in retentionService.js.
    prisma.healthConsent.deleteMany({ where: { userId } }),
    // The body-numbers consent row goes with the account like the device one.
    // It carries no values - only that consent was given and when - but it is
    // a per-person record and has no purpose once the person is gone.
    prisma.biometricConsent.deleteMany({ where: { userId } }),
    // Health profile (gamified onboarding v2): allergies, substance answers,
    // medication reminders and their consent. Among the most sensitive rows
    // here, wired in with the migration that created them.
    prisma.medicationReminder.deleteMany({ where: { userId } }),
    prisma.healthProfile.deleteMany({ where: { userId } }),
    prisma.healthProfileConsent.deleteMany({ where: { userId } }),
    // Fitness assistant. Conversations cascade to their messages via the FK,
    // but messages are deleted explicitly first anyway: the delete is ordered
    // for a reader, not just for the database, and "the transcript goes" is
    // the single most important line in this list to be able to point at.
    //
    // These transcripts are the most sensitive rows this service holds — a
    // user may have typed an injury, a condition or a medication into them —
    // so they must never outlive the account.
    prisma.assistantMessage.deleteMany({ where: { userId } }),
    prisma.assistantConversation.deleteMany({ where: { userId } }),
    prisma.assistantMemory.deleteMany({ where: { userId } }),
    prisma.assistantRateLimitLog.deleteMany({ where: { userId } }),
    prisma.assistantConsent.deleteMany({ where: { userId } }),
    // Cycle tracking. The most sensitive rows in this service — a record of
    // someone's menstrual history — so they go with the account without
    // exception. Wired in with the migration that created them, not later.
    prisma.cyclePhaseEntry.deleteMany({ where: { userId } }),
    prisma.cycleTrackingProfile.deleteMany({ where: { userId } }),
    // --- Health Ledger ----------------------------------------------------
    //
    // A daily record of exactly what someone ate, plus their nutrition targets
    // and the plan built from them. This is behavioural health data at the
    // most granular resolution the service holds, and it is the newest table
    // group, so it is the easiest to forget. It must not outlive the account.
    //
    // FK order matters twice over:
    //   - SavedMealLine cascades from SavedMeal, and PlanItemCompletion from
    //     PlanItem, so deleting the parents is enough for those.
    //   - HealthGoal is the parent of NutritionTarget (Cascade), but the target
    //     is also deleted explicitly because it is what "why these numbers?"
    //     reads, and the goal row goes last so the cascade cannot beat us to
    //     it during an account deletion where the order is being read by a
    //     human trying to prove what was erased.
    prisma.savedMeal.deleteMany({ where: { userId } }),
    prisma.foodLog.deleteMany({ where: { userId } }),
    prisma.foodItem.deleteMany({ where: { createdByUserId: userId } }),
    prisma.scoreDaySnapshot.deleteMany({ where: { userId } }),
    prisma.foodPhotoRequestLog.deleteMany({ where: { userId } }),
    prisma.planItem.deleteMany({ where: { userId } }),
    prisma.nutritionTarget.deleteMany({ where: { userId } }),
    prisma.healthCondition.deleteMany({ where: { userId } }),
    prisma.doctorAppointment.deleteMany({ where: { userId } }),
    // The goal row is the FK parent of NutritionTarget, so it goes after it.
    prisma.healthGoal.deleteMany({ where: { userId } }),
    // Medical documents: a prescription or a lab report is the single most
    // sensitive row this service can hold, and it is the newest one. Leaving
    // it behind on account deletion would be the worst possible miss, so it is
    // deleted here and not deferred to the scope-revocation path (which only
    // runs if the user happened to visit the consent screen first).
    //
    // SavedMealLine and PlanItemCompletion are deliberately absent from this
    // list: both are onDelete: Cascade from a parent deleted above, so an
    // explicit delete would be redundant.
    prisma.medicalDocument.deleteMany({ where: { userId } }),
  ]);

  // The medical BLOBS are swept here, after the transaction has committed.
  //
  // Not inside it, and not at all if the transaction throws: GCS is not a
  // database, so a storage outage must never roll back an erasure that has
  // already been committed, and holding a transaction open across a network
  // call to a third party is how a deletion silently stops completing.
  //
  // This is a prefix sweep rather than a list of paths, because by this point
  // the rows naming those paths are gone — read the paths first and a partial
  // failure leaves blobs with no database row and no record of what they were.
  // Every object is written under `medical/{userId}/`, so the prefix reclaims
  // them without needing the row to have survived.
  //
  // Best-effort, and deliberately not rethrown: the database erasure is the
  // legally meaningful part and it has already happened. An orphaned object
  // under a random-uuid name in a per-user prefix cannot be reached by any code
  // path in this service, so it is a storage-lifecycle concern, not a privacy
  // hole. A bucket retention rule is the second line of defence.
  try {
    const { deleteUserObjects } = await import('./ledger/medicalDocumentStorage.js');
    await deleteUserObjects(userId);
  } catch (err) {
    console.error('[consent] medical blob sweep failed:', err?.message);
  }

  // The food photos get the same treatment, for the same reason and with the
  // same trade-off. The ledger stores the photo on the log rather than behind a
  // short-lived link - the user chose to keep it - so deleting the account has
  // to reclaim the objects, not only the rows, or a picture of somebody's diet
  // outlives the account that was supposed to take it with them.
  //
  // Prefix sweep, best-effort, after the transaction, never rethrown. A bucket
  // retention rule is the second line of defence for whatever GCS refuses here.
  try {
    const { deleteUserPhotos } = await import('./ledger/foodPhotoStorage.js');
    await deleteUserPhotos(userId);
  } catch (err) {
    console.error('[consent] food photo blob sweep failed:', err?.message);
  }
}
