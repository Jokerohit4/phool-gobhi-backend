import { PrismaClient } from '@prisma/client';
import { exportUserAcrossServices } from '../utils/exportAcrossServices.js';
const prisma = new PrismaClient();

// Platform-wide DPDPA access right (s.11): one document covering everything
// Phool Gobhi holds about a person, assembled from every service that stores
// any of it.
//
// The structural twin of deleteUserService, with one deliberate difference in
// failure policy. Erasure refuses to proceed on a partial result, because a
// half-erasure leaves personal data alive with no account left to retry from.
// An export has no such trap — nothing is destroyed — so a partial result is
// returned WITH the gaps named, which serves the person better than an error
// page that tells them nothing about anything.
export async function buildFullExportService(userId) {
  const [user, addresses, locations, rewards, platformReview, gymLinks, devices] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.savedAddress.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.exploreLocationReceipt.findMany({ where: { userId }, orderBy: { acknowledgedAt: 'asc' } }),
    prisma.exploreRewardReceipt.findMany({ where: { userId }, orderBy: { acknowledgedAt: 'asc' } }),
    prisma.platformReview.findUnique({ where: { customerId: userId } }),
    prisma.gymLink.findMany({ where: { userId }, orderBy: { linkedAt: 'asc' } }),
    prisma.userDevice.findMany({ where: { userId }, orderBy: { firstSeenAt: 'asc' } }),
  ]);

  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const { sections, failures } = await exportUserAcrossServices(userId);

  return {
    exportedAt: new Date().toISOString(),
    // Named so a reader can tell what this document is without our help, and
    // so a future format change is detectable rather than silent.
    format: 'phool-gobhi-personal-data-export/v1',
    account: {
      userId: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      accountType: user.type,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      fitnessGoals: user.fitnessGoals,
      experienceLevel: user.experienceLevel,
      weeklyFrequencyIntent: user.weeklyFrequencyIntent,
      profileImageUrl: user.profileImageUrl,
      referralCode: user.referralCode,
      // Whether someone referred them is part of their own record; who that
      // person is would be a handle to a third party's account.
      wasReferred: user.referredByUserId !== null,
      leaderboardOptIn: user.leaderboardOptIn,
      // Onboarding branch answers — preference data about this person, so it
      // belongs in their DPDPA access-right export like every other answer
      // they gave us. Added here at the same time as the columns, rather than
      // left to be noticed later.
      currentlyWorksOut: user.currentlyWorksOut,
      trainingLocationPref: user.trainingLocationPref,
      trainingLocationOther: user.trainingLocationOther,
      appMode: user.appMode,
      freeTimeWindow: user.freeTimeWindow,
      // Coach-journey membership + prompt state (B2), same class as the
      // onboarding answers above: this person's own record.
      linkedGymId: user.linkedGymId,
      homeUnclaimedGymId: user.homeUnclaimedGymId,
      pendingGymPromptGymId: user.pendingGymPromptGymId,
      gymLinkNotice: user.gymLinkNotice,
      firstVisitBadgeConsent: user.firstVisitBadgeConsent,
      firstVisitBadgeConsentAt: user.firstVisitBadgeConsentAt,
      joinedAt: user.createdAt,
    },
    gymLinks: gymLinks.map((l) => ({
      gymId: l.gymId,
      source: l.source,
      linkedAt: l.linkedAt,
      firstVerifiedCheckinAt: l.firstVerifiedCheckinAt,
      removedAt: l.removedAt,
      removedByPartnerId: l.removedByPartnerId,
      selfRelinkBlocked: l.selfRelinkBlocked,
    })),
    devices: devices.map((d) => ({
      installId: d.installId, platform: d.platform, firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt,
    })),
    savedAddresses: addresses.map((a) => ({
      label: a.label, address: a.formattedAddress, lat: a.lat, lng: a.lng, savedAt: a.createdAt,
    })),
    exploration: { locationReceipts: locations.map(r => r.payload), rewardReceipts: rewards.map(r => r.payload) },
    platformReview: platformReview
      ? { rating: platformReview.rating, comment: platformReview.comment, at: platformReview.createdAt }
      : null,
    ...sections,
    // Stated rather than left to inference, because "we hold nothing else" is
    // a claim worth making explicitly in a document like this.
    notIncluded: {
      credentials: 'your password hash and login/refresh tokens are security material, not personal data we would ever hand back',
      otpCodes: 'one-time codes are short-lived and are not retained',
      internalTelemetry: 'aggregate analytics events are not keyed to your account in a form we return here',
    },
    // If anything failed, the document says so at the top level rather than
    // quietly presenting itself as complete.
    ...(failures.length > 0
      ? {
          incomplete: true,
          incompleteSections: failures.map((f) => f.service),
          incompleteNote:
            'Some sections could not be retrieved when this export was generated. Nothing has been deleted — please request the export again.',
        }
      : {}),
  };
}
