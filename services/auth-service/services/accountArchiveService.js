// Closing an account by ARCHIVING it: nothing is deleted.
//
// The business decision (pending legal advice on what must eventually be
// deleted) is to retain all data. Retaining is the reversible choice — anything
// kept can be deleted or anonymised later, while anything already erased cannot be
// brought back — so this is built so a later, narrower policy is a code change in
// one place, not a data recovery.
//
// What closing an account does, in place on the same User row:
//   - the identifying fields move into `archivedData` and the live columns become
//     neutral. The phone and email are therefore free, so signing in again with the
//     same number creates a brand-new user with a new id and no history;
//   - the person can never come back to the old account: it is deactivated, its
//     sessions are revoked, and nothing in the apps can reach it;
//   - their gym memberships end (the links stay on record) so they leave every
//     partner's roster;
//   - leaderboards stop showing them, and everywhere a name is shown it now reads
//     "Former member".
// Everything else — profile answers, health, bookings, wallet, buddy photos and chats,
// gym records and payments — is left exactly as it was.
//
// Prisma is injected so tests run against an in-memory double.

export const ARCHIVED_DISPLAY_NAME = 'Former member';

/** The identifying fields, exactly as they were, for the retained snapshot. */
export function identitySnapshot(user, now) {
  return {
    name: user.name ?? null,
    phone: user.phone ?? null,
    email: user.email ?? null,
    profileImageUrl: user.profileImageUrl ?? '',
    fcmToken: user.fcmToken ?? '',
    referralCode: user.referralCode ?? null,
    archivedAt: now.toISOString(),
  };
}

/**
 * Archive one account. Returns false when it was already archived (so a retry,
 * or a double tap, is a harmless no-op that never overwrites the snapshot with
 * the already-neutralised values).
 *
 * @param {object} prisma
 * @param {object} user  the row as it is now
 */
export async function archiveUserAccount(prisma, user, { now = new Date() } = {}) {
  if (user.archivedAt) return false;
  const userId = user.id;
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        archivedAt: now,
        archivedData: identitySnapshot(user, now),
        // Deactivated: login, refresh and Google sign-in all refuse an inactive account.
        isActive: false,
        // Neutral, so no screen can show or look up the person any more. A null
        // phone/email also frees the unique constraint for a new account.
        name: ARCHIVED_DISPLAY_NAME,
        phone: null,
        email: null,
        profileImageUrl: '',
        fcmToken: '',
        referralCode: null,
        leaderboardOptIn: false,
        linkedGymId: null,
      },
    }),
    // Membership ends but the link rows stay on record.
    prisma.gymLink.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now } }),
    // Credentials, not data: nobody can resume the old account.
    prisma.refreshToken.deleteMany({ where: { userId } }),
  ]);
  return true;
}
