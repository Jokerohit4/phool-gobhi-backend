import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const BUDDY_SERVICE_URL = process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Verifies a customer-supplied matchId is a real, active buddy-service Match
// that includes userId, and returns the other member's id — never trusts an
// otherUserId supplied directly by the client (see PairedStreak's schema
// comment).
export async function verifyMatchMembership(matchId, userId) {
  const res = await fetch(`${BUDDY_SERVICE_URL}/internal/matches/${matchId}/verify/${userId}`, {
    headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(BUDDY_SERVICE_URL)) },
  });
  if (!res.ok) throw { status: 502, error: `buddy-service internal call failed (${res.status})` };
  const body = await res.json();
  return body.data;
}
