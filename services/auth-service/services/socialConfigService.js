// Social config service (A1 stub, real read since B14).
//
// Social surfaces (buddy, chat, paired streaks) are governed by their own flag
// in the registry, but the customer app also reads a single top-level
// `social: { enabled }` switch from GET /app-config that can mute every social
// surface at once without touching individual flags. A1 ships the fail-closed
// constant (disabled); the real store — an admin-editable singleton row, like
// the other *Setting models — is B14's to add, at which point this reads it from
// the same storage `updateAppConfigAdmin` writes. It defaults to `false`.
//
// Contract: always resolves (never throws), always an object with a boolean.

import prisma from '../db/prisma.js';

/** Pure derivation of the switch from an already-loaded config blob. */
export function socialFromConfig(config) {
  return { enabled: config?.social?.enabled === true };
}

/**
 * The platform-wide social master switch.
 *
 * @returns {Promise<{ enabled: boolean }>}
 */
export async function get() {
  try {
    const row = await prisma.appVersionSetting.findUnique({ where: { id: 1 } });
    const enabled = row?.config?.social?.enabled === true;
    return { enabled };
  } catch {
    return { enabled: false };
  }
}
