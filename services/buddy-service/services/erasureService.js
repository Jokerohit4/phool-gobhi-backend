import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary.js';
const prisma = new PrismaClient();

// DPDPA erasure for this service, called by auth-service when a user
// deletes their account. Buddy holds the most personal data on the
// platform — a written bio, uploaded photos of the user's face, and the
// full text of private conversations — so none of it may survive the
// account that produced it.
//
// Chat is the one genuinely hard case. A conversation has two authors, and
// the other person did not ask to be erased. We delete the whole Match
// (which cascades its messages) rather than leaving one half of a dialogue
// standing: a thread where every message from one side has vanished is both
// useless to the survivor and still evidence that the deleted person existed
// and said things. Removing the conversation is the cleaner read of erasure.
export async function eraseUserService(userId) {
  const profile = await prisma.buddyProfile.findUnique({
    where: { userId },
    include: { photos: true },
  });

  // Cloudinary first: if a row is deleted but its image isn't, the image
  // becomes unreachable and therefore un-deletable — a permanent orphan of
  // exactly the data we were asked to erase. Best-effort per photo so one
  // failure can't strand the rest.
  const photoFailures = [];
  for (const photo of profile?.photos ?? []) {
    if (!photo.publicId) continue;
    try {
      await cloudinary.uploader.destroy(photo.publicId);
    } catch (err) {
      console.error('erase: Cloudinary destroy failed for', photo.publicId, err.message);
      photoFailures.push(photo.publicId);
    }
  }

  const matches = await prisma.match.findMany({
    where: { OR: [{ userLowId: userId }, { userHighId: userId }] },
    select: { id: true },
  });
  const matchIds = matches.map((m) => m.id);

  await prisma.$transaction([
    // ChatMessage cascades from Match (onDelete: Cascade), but messages this
    // user sent into a match that somehow outlives the delete are removed
    // explicitly first so no authored text can survive on a technicality.
    prisma.chatMessage.deleteMany({ where: { senderId: userId } }),
    ...(matchIds.length > 0
      ? [prisma.chatMessage.deleteMany({ where: { matchId: { in: matchIds } } })]
      : []),
    prisma.match.deleteMany({ where: { OR: [{ userLowId: userId }, { userHighId: userId }] } }),
    // Both directions: swipes this user made, and swipes made ON them —
    // the latter is still a record of this user having existed in someone
    // else's feed.
    prisma.swipe.deleteMany({ where: { OR: [{ swiperId: userId }, { swipeeId: userId }] } }),
    prisma.blockedUser.deleteMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    }),
    prisma.buddyFilter.deleteMany({ where: { userId } }),
    // Photos cascade from BuddyProfile, but deleted explicitly so the row
    // count returned below is honest about what went.
    ...(profile ? [prisma.buddyPhoto.deleteMany({ where: { buddyProfileId: profile.id } })] : []),
    prisma.buddyProfile.deleteMany({ where: { userId } }),
  ]);

  return {
    erased: true,
    matchesRemoved: matchIds.length,
    photosRemoved: profile?.photos.length ?? 0,
    // Surfaced rather than swallowed: an image we failed to destroy is a
    // real, reportable gap in the erasure, not a silent partial success.
    cloudinaryFailures: photoFailures,
  };
}
