import { googleIdTokenHeader } from '../utils/googleIdToken.js';

// Copied from booking-service/middleware/requireFeatureFlag.js (W7). Only the
// 403 body differs: buddy's error contract wants a readable sentence plus a
// code, because old app builds show `error` to the user as-is.

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const FLAG_CACHE_TTL_MS = 30_000;
// A hung auth-service must not hold every gated request open: the fetch is cut
// off after this long, and then treated like any other failed refresh.
const FLAG_FETCH_TIMEOUT_MS = 2_000;
// After a failed refresh, keep serving what we have and do not try again for
// this long — otherwise every request during an outage re-fetches (and, with no
// timeout, used to wait on) auth-service.
const FLAG_RETRY_AFTER_FAILURE_MS = 5_000;
let cachedFlags = null;
let cachedAt = 0;
let nextRetryAt = 0;
// The refresh already on the wire, if any. A cold start (or a TTL expiry)
// meets a BURST of requests — one app launch fans out into a dozen-plus routes
// that each check a flag — and without this every one of them missed the
// cache at once and fetched /app-config itself: ~17 identical calls in under
// 100ms in auth-service-dev logs, 2026-10-01. Everyone now awaits one fetch.
let inFlight = null;

// Server-side enforcement of the admin-controlled feature flags served at
// GET /app-config (auth-service) — same convention booking-service and
// challenge-service use. Client-side hiding is not enough: buddy must stay off
// in prod until the safety work is verified, and an old app build (or a
// direct API call) ignores client-side flags.
async function getFeatureFlags() {
  const now = Date.now();
  if (cachedFlags && now - cachedAt < FLAG_CACHE_TTL_MS) return cachedFlags;
  // Recent failed refresh: serve last-known (or the fail-closed {} on a cold
  // start) until the retry window opens.
  if (cachedFlags && now < nextRetryAt) return cachedFlags;
  if (!inFlight) inFlight = refreshFlags().finally(() => { inFlight = null; });
  return inFlight;
}

async function refreshFlags() {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/app-config`, {
      headers: await googleIdTokenHeader(AUTH_SERVICE_URL),
      signal: AbortSignal.timeout(FLAG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`app-config fetch failed (${res.status})`);
    const body = await res.json();
    cachedFlags = body.features || {};
    cachedAt = Date.now();
    nextRetryAt = 0;
  } catch (err) {
    // Fail closed on the very first call (no last-known-good yet), fail open
    // to the last-known value on a transient blip thereafter.
    console.error('requireFeatureFlag: failed to refresh flags:', err.message);
    if (!cachedFlags) cachedFlags = {};
    nextRetryAt = Date.now() + FLAG_RETRY_AFTER_FAILURE_MS;
  }
  return cachedFlags;
}

// Warm the cache at module load so the first request after a cold start does
// not wait on auth-service. Never throws or rejects (refreshFlags swallows its
// own errors; the catch is belt-and-braces) and is skipped under node --test,
// where it would fire an unmocked fetch at import time.
export function warmFeatureFlags() {
  if (process.env.NODE_TEST_CONTEXT && process.env.BUDDY_FLAG_WARM_FORCE !== '1') return;
  try {
    getFeatureFlags().catch(() => {});
  } catch {
    /* ignore */
  }
}
warmFeatureFlags();

export async function isFeatureEnabled(flagName) {
  const flags = await getFeatureFlags();
  return !!flags?.[flagName]?.enabled;
}

// 403, not 404: the app reads a 404 on /profile/me as "no profile yet".
export const FEATURE_DISABLED_BODY = { error: "Gym buddy isn't available yet.", code: 'FEATURE_DISABLED' };

export const requireFeatureFlag = (flagName) => async (req, res, next) => {
  if (!(await isFeatureEnabled(flagName))) {
    return res.status(403).json(FEATURE_DISABLED_BODY);
  }
  next();
};
