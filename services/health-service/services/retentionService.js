import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// DPDPA purpose limitation: personal data may only be kept as long as the
// purpose it was collected for still needs it. That is NOT one number — the
// data here falls into three genuinely different buckets, and conflating
// them is how you either delete something you were legally obliged to keep
// or keep something you had no reason to.
//
//  1. PURPOSE-LIMITED TELEMETRY — collected to measure a feature, useless as
//     per-user rows once aggregated. These expire on a clock, and are the
//     only thing this sweep touches.
//
//  2. THE USER'S OWN RECORD — workout sessions, biometric entries,
//     personalisation. The purpose is "show this person their own history",
//     which does not expire while the account exists. Auto-deleting a user's
//     training history after N months would be a product bug wearing a
//     compliance costume. These go when the account goes (see
//     consentService.deleteAllDataService), not on a timer.
//
//  3. STATUTORY RETENTION — financial and settlement records in
//     wallet/booking-service. Legally required to be KEPT (Income Tax,
//     PMLA), and DPDPA's erasure right yields to that. Never swept, never
//     erased on account deletion; they carry no PII once the auth User row
//     is gone. Nothing in this service falls in this bucket, but it's named
//     here so the distinction survives the next person reading this file.
export const RETENTION_DEFAULTS = {
  // Suggestion impressions/votes (FR-15). Their whole purpose is computing
  // GS-5's action rate, which is an aggregate — a two-year-old individual
  // impression row tells us nothing the aggregate hasn't already absorbed.
  suggestionFeedbackDays: 180,
};

// One admin-editable row, same singleton convention as
// challenge-service's CoinEconomyConfig — so a retention period can be
// changed on legal advice without a redeploy.
export async function loadRetentionPolicy() {
  const row = await prisma.retentionPolicy.findUnique({ where: { id: 1 } });
  return { ...RETENTION_DEFAULTS, ...(row ?? {}) };
}

export async function updateRetentionPolicy(patch, updatedBy) {
  const data = {};
  if (patch.suggestionFeedbackDays !== undefined) {
    const days = Number(patch.suggestionFeedbackDays);
    // A floor of 30 days is deliberate: set this to 0 or 1 and the sweep
    // deletes telemetry before it has been aggregated, silently destroying
    // the metric it exists to produce.
    if (!Number.isInteger(days) || days < 30 || days > 3650) {
      const err = new Error('suggestionFeedbackDays must be an integer between 30 and 3650');
      err.status = 400;
      throw err;
    }
    data.suggestionFeedbackDays = days;
  }
  return prisma.retentionPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, ...RETENTION_DEFAULTS, ...data, updatedBy },
    update: { ...data, updatedBy },
  });
}

// Idempotent and safe to re-run: it deletes by age, so running twice in a
// row simply finds nothing the second time. Intended to be called by a
// scheduled workflow, the same way the Razorpay reconcile sweep is.
export async function runRetentionSweepService() {
  const policy = await loadRetentionPolicy();
  const cutoff = new Date(Date.now() - policy.suggestionFeedbackDays * 24 * 60 * 60 * 1000);

  const { count } = await prisma.suggestionFeedback.deleteMany({
    where: { shownAt: { lt: cutoff } },
  });

  return {
    sweptAt: new Date().toISOString(),
    policy,
    deleted: { suggestionFeedback: count },
    // Stated in the response, not just in a comment, so whoever reads the
    // sweep's output knows what it deliberately left alone.
    retainedByDesign: {
      userOwnRecord: 'workout sessions, biometric entries, personalisation — deleted with the account, never on a timer',
      statutory: 'none in this service; financial/settlement records live in wallet/booking-service and are never swept',
    },
  };
}
