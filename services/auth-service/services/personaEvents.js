// What happens elsewhere when a user's persona changes. Fire-and-forget, after
// the switch has committed: each receiver re-reads the user from
// /internal/users/:id when it acts, so a dropped call only delays it (the
// switch itself never fails because health or challenge is down).
//
//   health-service    /internal/journey/persona-changed  — swap the plan track
//                     (workout <-> wellness) without losing either side.
//   challenge-service /internal/persona-changed          — pause personal
//                     challenges for the old persona, resume the new one's, and
//                     give the current streak week grace.

import { track } from '../utils/analytics.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const RECEIVERS = [
  { name: 'health-service', path: '/internal/journey/persona-changed', url: () => process.env.HEALTH_SERVICE_URL || 'http://health-service:5009' },
  { name: 'challenge-service', path: '/internal/persona-changed', url: () => process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008' },
];

async function post(receiver, body) {
  const base = receiver.url();
  try {
    const res = await fetch(`${base}${receiver.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(),
        ...(await googleIdTokenHeader(base)),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`[persona] ${receiver.name} responded ${res.status}`);
  } catch (err) {
    console.error(`[persona] ${receiver.name} notify failed:`, err.message);
  }
}

/**
 * @param {{ userId: number, fromPersona: string|null, toPersona: string, source: string }} change
 */
export function notifyPersonaChanged(change) {
  track('persona_switched', change.userId, {
    from_persona: change.fromPersona,
    to_persona: change.toPersona,
    source: change.source,
  });
  const body = {
    userId: change.userId,
    fromPersona: change.fromPersona,
    toPersona: change.toPersona,
    source: change.source,
  };
  // Not awaited by callers; returned so tests can wait on it.
  return Promise.all(RECEIVERS.map((r) => post(r, body)));
}
