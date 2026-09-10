import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// DPDPA access right (s.11) for the gym-buddy layer, called by auth-service's
// platform-wide export. The mirror of erasureService: the same data, handed
// back instead of destroyed.
//
// Chat is where access and third-party privacy pull against each other. A
// conversation is personal data about BOTH people, and the other person never
// asked for their words to be handed to anyone. So the export carries:
//   - every message this user wrote, in full - it is their own text;
//   - for messages they received, only the fact and timing of them.
// That gives a complete picture of what we hold ABOUT the requester without
// disclosing a third party's content, which is the same line an erasure walks
// when it deletes a whole match rather than half a dialogue.
export async function buildExportService(userId) {
  const profile = await prisma.buddyProfile.findUnique({
    where: { userId },
    include: { photos: { orderBy: { order: 'asc' } }, filter: true },
  });

  const matches = await prisma.match.findMany({
    where: { OR: [{ userLowId: userId }, { userHighId: userId }] },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
    orderBy: { matchedAt: 'asc' },
  });

  const [swipesMade, swipesReceived, blocks] = await Promise.all([
    prisma.swipe.findMany({ where: { swiperId: userId }, orderBy: { createdAt: 'asc' } }),
    prisma.swipe.count({ where: { swipeeId: userId } }),
    prisma.blockedUser.findMany({ where: { blockerId: userId }, orderBy: { createdAt: 'asc' } }),
  ]);

  return {
    profile: profile
      ? {
          bio: profile.bio,
          socialMediaUrl: profile.socialMediaUrl,
          gender: profile.gender,
          dateOfBirth: profile.dateOfBirth,
          fitnessGoals: profile.fitnessGoals,
          approximateLocation: { lat: profile.lat, lng: profile.lng },
          isDiscoverable: profile.isDiscoverable,
          isActive: profile.isActive,
          createdAt: profile.createdAt,
          photoUrls: profile.photos.map((p) => p.url),
        }
      : null,
    discoveryFilter: profile?.filter
      ? {
          radiusKm: profile.filter.radiusKm,
          minAge: profile.filter.minAge,
          maxAge: profile.filter.maxAge,
          genders: profile.filter.genders,
          fitnessGoals: profile.filter.fitnessGoals,
        }
      : null,
    matches: matches.map((m) => ({
      matchedAt: m.matchedAt,
      status: m.status,
      unmatchedAt: m.unmatchedAt,
      // Deliberately not the counterparty's id: it is a handle to another
      // person's account and adds nothing to the requester's own record.
      messagesYouSent: m.messages
        .filter((msg) => msg.senderId === userId)
        .map((msg) => ({ sentAt: msg.createdAt, body: msg.body })),
      messagesYouReceived: m.messages.filter((msg) => msg.senderId !== userId).length,
    })),
    swipes: {
      // Who they swiped on is a record of their own activity; the ids are
      // included because "you liked account 412" is meaningless to anyone
      // without our database, and omitting them would make the count
      // unauditable.
      made: swipesMade.map((s) => ({ at: s.createdAt, action: s.action, onUserId: s.swipeeId })),
      // The reverse direction is other people's activity. The requester is
      // entitled to know it happened, not to know who did it.
      receivedCount: swipesReceived,
    },
    blocksYouMade: blocks.map((b) => ({ at: b.createdAt, blockedUserId: b.blockedId, reason: b.reason })),
    notIncluded: {
      messagesFromOthers:
        'the text of messages other people sent you is their personal data as well as yours, so only the count is included',
      swipesOnYou: 'who swiped on you is other people\'s activity; only the total is included',
    },
  };
}
