import { OAuth2Client } from 'google-auth-library';
import requireInternal from './requireInternal.js';

// Cloud Scheduler can authenticate with an OIDC token but cannot carry the
// shared INTERNAL_API_KEY. This guard accepts EITHER the normal internal key OR a
// Google-signed ID token whose audience is this service and whose verified email
// is the one scheduler service account named in WATER_REMINDER_SCHEDULER_SA.
// Anything else falls through to requireInternal (403). Cloud Run IAM still
// restricts who can reach the service at all; this is the application-level
// second check.
const client = new OAuth2Client();

export function makeRequireInternalOrScheduler({ verify } = {}) {
  const verifyToken =
    verify ??
    (async (idToken, audience) => {
      const ticket = await client.verifyIdToken({ idToken, audience });
      return ticket.getPayload();
    });

  return async function requireInternalOrScheduler(req, res, next) {
    const expectedEmail = (process.env.WATER_REMINDER_SCHEDULER_SA || '').trim();
    const audience = (process.env.WATER_REMINDER_AUDIENCE || '').trim();
    const header = String(req.headers.authorization || '');
    if (expectedEmail && audience && header.startsWith('Bearer ')) {
      try {
        const payload = await verifyToken(header.slice(7), audience);
        if (payload?.email_verified !== false && payload?.email === expectedEmail) return next();
      } catch {
        // Not a valid scheduler token: fall through to the internal-key check.
      }
    }
    return requireInternal(req, res, next);
  };
}

export default makeRequireInternalOrScheduler();
