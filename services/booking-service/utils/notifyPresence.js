import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const CHALLENGE_SERVICE_URL = process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Tells challenge-service when a person comes in or goes out of a gym. It holds
// the coin rule (a finished workout is paid only once the person has checked out
// by scan), so it needs to know who is currently inside.
//
// Best-effort, like every other fan-out from this service: a failure never blocks
// the check-in or check-out it is attached to. Returns the answer when there is
// one ({ released }, the coins a check-out by scan just paid out), otherwise null.
// A person whose check-out could not reach challenge-service simply has their
// coins stay held, which is the safe side of the rule.
export async function notifyPresence({ userId, gymId, state, method, at, date, source }) {
  try {
    const res = await axios.post(
      `${CHALLENGE_SERVICE_URL}/internal/presence`,
      { userId, gymId, state, method, at, date, source },
      { timeout: 4000, headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(CHALLENGE_SERVICE_URL)) } },
    );
    return res.data?.data ?? null;
  } catch (err) {
    console.error('[challenge-service] notifyPresence failed for', userId, gymId, state, err.message);
    return null;
  }
}
