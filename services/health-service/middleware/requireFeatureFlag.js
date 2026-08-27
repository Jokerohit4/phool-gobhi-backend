import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const FLAG_CACHE_TTL_MS = 30_000;
let cachedFlags = null;
let cachedAt = 0;

// Server-side enforcement of the admin-controlled feature flags served at
// GET /app-config (auth-service) — same convention challenge-service uses.
// Client-side hiding (customer app's AppUpdateCubit) is not enough for a
// feature exposing new personal-data collection, so every customer-facing
// route here re-checks the same flag the admin panel controls.
async function getFeatureFlags() {
  if (cachedFlags && Date.now() - cachedAt < FLAG_CACHE_TTL_MS) return cachedFlags;
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/app-config`, {
      headers: await googleIdTokenHeader(AUTH_SERVICE_URL),
    });
    if (!res.ok) throw new Error(`app-config fetch failed (${res.status})`);
    const body = await res.json();
    cachedFlags = body.features || {};
    cachedAt = Date.now();
  } catch (err) {
    // Fail closed on the very first call (no last-known-good yet), fail open
    // to the last-known value on a transient blip thereafter.
    console.error('requireFeatureFlag: failed to refresh flags:', err.message);
    if (!cachedFlags) cachedFlags = {};
  }
  return cachedFlags;
}

export async function isFeatureEnabled(flagName) {
  const flags = await getFeatureFlags();
  return !!flags?.[flagName]?.enabled;
}

export const requireFeatureFlag = (flagName) => async (req, res, next) => {
  if (!(await isFeatureEnabled(flagName))) {
    return res.status(403).json({ error: 'FEATURE_DISABLED' });
  }
  next();
};
