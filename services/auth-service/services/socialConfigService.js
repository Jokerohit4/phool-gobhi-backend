// Social config service — MINIMAL STUB as of A1 (2026-10-16).
//
// Social surfaces (buddy, chat, paired streaks) are governed by their own flag
// in the registry, but the customer app also reads a single top-level
// `social: { enabled }` switch from GET /app-config that can mute every social
// surface at once without touching individual flags. A1 ships the fail-closed
// constant (disabled); the real store — an admin-editable singleton row, like
// the other *Setting models — is B14's to add, at which point this reads it.
//
// Contract: always resolves (never throws), always an object with a boolean.

/**
 * The platform-wide social master switch.
 *
 * @returns {Promise<{ enabled: boolean }>}
 */
export async function get() {
  // STUB: social off. B14 backs this with a settings row.
  return { enabled: false };
}
