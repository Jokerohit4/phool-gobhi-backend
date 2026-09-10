import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const CHALLENGE_SERVICE_URL = process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// challenge-service's AttendanceEventLog is the platform's single unified
// attendance signal: booking check-ins, self-check-ins and attendance-SaaS
// member check-ins all land in it, and /internal/workout-credit already
// verifies against it on every session finish. Reading it here rather than
// asking booking-service directly is what keeps the unlogged feed and the
// log-nudge covering all three paths instead of only the first.
//
// Best-effort: an unreachable challenge-service means "no attendance known"
// (an empty feed, no nudges) rather than an error. The feed is a prompt,
// and a prompt that fails closed is a non-event.
export async function fetchAttendanceSince(hours, { userId } = {}) {
  try {
    const res = await axios.get(`${CHALLENGE_SERVICE_URL}/internal/attendance-events`, {
      params: { hours, ...(userId ? { userId } : {}) },
      headers: {
        'x-internal-key': INTERNAL_API_KEY,
        ...(await googleIdTokenHeader(CHALLENGE_SERVICE_URL)),
      },
      timeout: 5000,
    });
    return res.data?.data ?? [];
  } catch (err) {
    console.error('[challenge-service] fetchAttendanceSince failed:', err.message);
    return [];
  }
}
