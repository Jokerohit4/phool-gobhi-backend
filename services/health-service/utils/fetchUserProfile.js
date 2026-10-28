import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Reads onboarding answers auth-service owns: training preferences seed a
// weekly training goal, while wellness-only preferences ground the assistant.
//
// Best-effort by design. A user with no reachable auth-service still gets a
// goal — the caller falls back to a neutral default — because failing to
// read an onboarding preference is not a reason to show someone a broken
// home screen. Same fire-and-forget posture as notifyChallengeService.
export async function fetchUserProfileInternal(userId) {
  try {
    // `/internal/:id`, matching booking- and wallet-service's notify helpers.
    // (CLAUDE.md's `/internal/users/:authId` is stale — that path doesn't
    // exist; `/internal/users/batch` is a different, POST-only endpoint.)
    const res = await axios.get(`${AUTH_SERVICE_URL}/internal/${userId}`, {
      headers: {
        'x-internal-key': INTERNAL_API_KEY,
        ...(await googleIdTokenHeader(AUTH_SERVICE_URL)),
      },
      timeout: 4000,
    });
    return res.data || null;
  } catch (err) {
    console.error('[auth-service] fetchUserProfileInternal failed for', userId, err.message);
    return null;
  }
}
