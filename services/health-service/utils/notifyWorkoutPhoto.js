import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const CHALLENGE_SERVICE_URL = process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Random 1-5 coin reward for the post-workout photo. The amount is rolled by
// the caller (server-side) and the key is tied to the session, so a retry can
// never pay twice. Never throws: false leaves the key unspent so a later
// upload can pay.
export async function creditWorkoutPhotoCoins({ userId, sessionId, amount }) {
  try {
    await axios.post(
      `${CHALLENGE_SERVICE_URL}/internal/coins/${userId}/credit`,
      {
        amount,
        description: 'Workout photo reward',
        idempotencyKey: `workout-photo-${sessionId}`,
      },
      {
        headers: {
          'x-internal-key': INTERNAL_API_KEY,
          ...(await googleIdTokenHeader(CHALLENGE_SERVICE_URL)),
        },
      },
    );
    return true;
  } catch (err) {
    if (err.response?.status !== 403) {
      console.error('[challenge-service] workout photo coins failed for', sessionId, err.message);
    }
    return false;
  }
}
