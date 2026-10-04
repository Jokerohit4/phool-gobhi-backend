import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const FLAG_CACHE_TTL_MS = 30_000;
let cachedFlags = null;
let cachedAt = 0;
// The refresh already on the wire, if any. A cold start (or a TTL expiry)
// meets a BURST of requests — one app launch fans out into a dozen-plus routes
// that each check a flag — and without this every one of them missed the
// cache at once and fetched /app-config itself: ~17 identical calls in under
// 100ms in auth-service-dev logs, 2026-10-01. Everyone now awaits one fetch.
let inFlight = null;

// Server-side enforcement of the admin-controlled feature flags served at
// GET /app-config (auth-service) — same convention challenge-service uses.
// Client-side hiding (customer app's AppUpdateCubit) is not enough for a
// feature exposing new personal-data collection, so every customer-facing
// route here re-checks the same flag the admin panel controls.
async function getFeatureFlags() {
  if (cachedFlags && Date.now() - cachedAt < FLAG_CACHE_TTL_MS) return cachedFlags;
  if (!inFlight) inFlight = refreshFlags().finally(() => { inFlight = null; });
  return inFlight;
}

async function refreshFlags() {
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

// TRANSITIONAL — same pairing as requireAnyFeatureFlag below; delete both once
// `workoutTracking` has been backfilled. Use for handlers that check their own
// flag (booking-service's attendance fan-in) rather than route middleware.
export async function isAnyFeatureEnabled(...flagNames) {
  const flags = await getFeatureFlags();
  return flagNames.some((name) => !!flags?.[name]?.enabled);
}

export const requireFeatureFlag = (flagName) => async (req, res, next) => {
  if (!(await isFeatureEnabled(flagName))) {
    return res.status(403).json({ error: 'FEATURE_DISABLED' });
  }
  next();
};

// TRANSITIONAL — delete once `workoutTracking` has been backfilled from the old
// `healthMetrics` value in every environment's stored config blob. Do not route
// new feature work through this.
//
// `workoutTracking` and `healthMetrics` used to be one boolean (healthMetrics)
// and health-service gated the workout-training routes on it. On 2026-10-04 that
// boolean was split: the training routes moved to `workoutTracking`, and
// `healthMetrics` was narrowed to the derived-score half.
//
// The problem with just switching them over: a stored config blob contains only
// the keys an admin has actually saved. In dev that blob predates
// `workoutTracking` entirely, so a straight `requireFeatureFlag('workoutTracking')`
// would resolve false and 404-in-disguise every workout route for every existing
// user — the exact failure this split is supposed to avoid. Accepting either flag
// keeps those routes serving for the duration of the rollout: it behaves exactly
// like the old `healthMetrics` gate, because for any blob written before the
// split `healthMetrics` IS the workout-tracking switch.
//
// The residual risk is deliberate and worth stating plainly: an admin who turns
// `workoutTracking` OFF after the split while leaving `healthMetrics` ON will
// still see workout routes served. That's why the flag registry marks
// `healthMetrics` as depending on `workoutTracking` rather than the reverse — the
// dependency only collapses once both are governed by the registry's dependency
// resolution, which post-rollout becomes a registry-wide rule instead of a
// per-route `requireAnyFeatureFlag` call. The rollout is one backfill:
//   UPDATE <appconfig> SET features = features || '{"workoutTracking": <healthMetrics.enabled>}'
// (deliberately not run here — it writes to a live database.)
export const requireAnyFeatureFlag = (...flagNames) => async (req, res, next) => {
  if (!(await isAnyFeatureEnabled(...flagNames))) {
    return res.status(403).json({ error: 'FEATURE_DISABLED' });
  }
  next();
};
