import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const CHALLENGE_SERVICE_URL = process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Best-effort, fire-and-forget — same posture as notifyCustomer/notifyPartner.
// A failure here must never block or roll back the booking action it's
// attached to. Idempotent on bookingId on the receiving side, so a retry
// after a transient failure is safe; this function does not retry itself.
// The receiving route is gated behind the streaksCoins feature flag
// (challenge-service's requireFeatureFlag), so calls here are a harmless
// no-op (403, swallowed) until an admin turns that phase on.
export async function recordAttendanceEvent({ userId, bookingId, gymId, attendedAt, source }) {
  try {
    await axios.post(
      `${CHALLENGE_SERVICE_URL}/internal/attendance-events`,
      { userId, bookingId, gymId, attendedAt, source },
      { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(CHALLENGE_SERVICE_URL)) } },
    );
  } catch (err) {
    console.error('[challenge-service] recordAttendanceEvent failed for booking', bookingId, err.message);
  }
}
