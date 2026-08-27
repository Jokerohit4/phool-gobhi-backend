import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const CHALLENGE_SERVICE_URL = process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Gamified layer (see the implementation plan's "Gamified layer" section) —
// best-effort, fire-and-forget, same posture as booking-service's own
// recordAttendanceEvent. A failure here must never block or roll back
// finishing a workout: on any error this resolves to "not credited" rather
// than throwing, so the caller can always still mark the session finished.
//
// One round trip, not two: challenge-service does the verification (today's
// AttendanceEventLog, any source) AND the crediting (its own
// CoinEconomyConfig.coinsPerVerifiedWorkout) server-side, so this service
// never needs to know the coin amount or reach into challenge-service's
// config — it just asks "was this workout eligible, and did it get paid."
// Idempotent on idempotencyKey against challenge-service's existing coin
// ledger, so a retry after a transient failure is safe. The receiving route
// is gated behind the streaksCoins feature flag, so this is a harmless
// no-op (403, swallowed -> not credited) until an admin turns that phase on.
export async function notifyWorkoutFinished({ userId, sessionId, description, idempotencyKey }) {
  try {
    const res = await axios.post(
      `${CHALLENGE_SERVICE_URL}/internal/workout-credit`,
      { userId, sessionId, description, idempotencyKey },
      {
        headers: {
          'x-internal-key': INTERNAL_API_KEY,
          ...(await googleIdTokenHeader(CHALLENGE_SERVICE_URL)),
        },
      },
    );
    return res.data?.data || { verified: false, credited: false };
  } catch (err) {
    console.error('[challenge-service] notifyWorkoutFinished failed for', idempotencyKey, err.message);
    return { verified: false, credited: false };
  }
}
