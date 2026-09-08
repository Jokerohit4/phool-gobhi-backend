import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const HEALTH_SERVICE_URL = process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Health & Activity layer twin of notifyChallengeService's
// recordAttendanceEvent — same fire-and-forget posture, same payload shape,
// called from the same two call sites (emitAttendanceSignals /
// emitMemberAttendanceSignals). Lets health-service auto-create a draft
// WorkoutSession the moment attendance is verified, so the quick-log sheet
// is a confirm/edit of an already-attached session rather than a blank
// create (see phool-gobhi-fitness-plus-BRD.html Tech §2, the "auto-draft"
// delta). The receiving route checks the healthMetrics flag itself, so this
// call is a harmless no-op until an admin turns that phase on — same
// posture as notifyChallengeService against streaksCoins.
export async function recordAttendanceForWorkout({ userId, bookingId, memberAttendanceId, gymId, attendedAt, source, idempotencyKey }) {
  try {
    await axios.post(
      `${HEALTH_SERVICE_URL}/internal/attendance-events`,
      { userId, bookingId, memberAttendanceId, gymId, attendedAt, source, idempotencyKey },
      { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(HEALTH_SERVICE_URL)) } },
    );
  } catch (err) {
    console.error('[health-service] recordAttendanceForWorkout failed for', idempotencyKey, err.message);
  }
}
