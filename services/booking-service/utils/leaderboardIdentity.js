// Leaderboard identity masking (product decision 2026-10-09, women-safety).
//
// Every leaderboard shows OTHER members as initials only -- no full name and
// no profile photo anywhere in the API payload, not just hidden by the UI.
// The requesting user's own row keeps their full name + photo and is marked
// `isMe: true` so the client can highlight it.
//
// `name` is kept on every entry (set to the initials for others) so older app
// builds that render `entry.name` keep working without ever receiving a full
// name.

// "Priya Sharma" -> "P.S."; "Priya" -> "P."; "" / null -> "Member".
// Uses at most first + last word so "Priya K Sharma" -> "P.S.".
export function toInitials(fullName) {
  if (typeof fullName !== 'string') return 'Member';
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'Member';
  const picked = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  const letters = picked
    .map((w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter(Boolean)
    .map((ch) => `${ch.toUpperCase()}.`);
  return letters.length ? letters.join('') : 'Member';
}

// Identity fields for one leaderboard row. Never spreads the raw user object.
export function leaderboardIdentity(user, isMe) {
  if (isMe) {
    const name = user?.name || 'You';
    return {
      isMe: true,
      name,
      displayName: name,
      initials: toInitials(user?.name),
      photoUrl: user?.profileImageUrl || null,
    };
  }
  const initials = toInitials(user?.name);
  return {
    isMe: false,
    name: initials,
    displayName: initials,
    initials,
    photoUrl: null,
  };
}
