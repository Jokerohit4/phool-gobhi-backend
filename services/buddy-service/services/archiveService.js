import prisma from '../db/prisma.js';
import { profileChanged } from '../utils/buddyCaches.js';

// Account ARCHIVE for this service, called by auth-service when a user closes
// their account. The counterpart of erasureService, for the retain-everything
// mode: nothing is deleted. The profile, photos, records, swipes, matches and
// every chat message stay in the database; the person simply disappears from
// everyone else's view.
//
//  - isActive=false is the same switch moderation uses for a suspended user: out
//    of every discovery deck and blocked from acting.
//  - isDiscoverable=false keeps them out even if they were ever reinstated.
//  - Every active match ends (status 'unmatched'), so the people they were talking
//    to stop seeing a live chat with someone who has left. The messages remain.
//
// Idempotent: archiving someone twice, or someone with no buddy profile, is a
// harmless no-op that reports zero ended matches.
export async function archiveUserService(userId) {
  const now = new Date();
  const [, ended] = await prisma.$transaction([
    prisma.buddyProfile.updateMany({ where: { userId }, data: { isActive: false, isDiscoverable: false } }),
    prisma.match.updateMany({
      where: { status: 'active', OR: [{ userLowId: userId }, { userHighId: userId }] },
      data: { status: 'unmatched', unmatchedBy: userId, unmatchedAt: now },
    }),
  ]);
  profileChanged(userId);
  return { archived: true, endedMatches: ended.count };
}
