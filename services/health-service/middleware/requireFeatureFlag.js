import { googleIdTokenHeader } from '../utils/googleIdToken.js';

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
// GET /app-config (auth-service) — same convention challenge-service uses.
// Client-side hiding (customer app's AppUpdateCubit) is not enough for a
// feature exposing new personal-data collection, so every customer-facing
// route here re-checks the same flag the admin panel controls.
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

// Warm the cache at module load so the first request after a cold start does
// not block on auth-service. Fire-and-forget: refreshFlags() never rejects, the
// extra catch is belt-and-braces, and failure handling (2s timeout, 5s retry,
// fail-closed first call) is exactly the normal path. Only on Cloud Run
// (K_SERVICE) and never under tests.
//
// The cache is then kept warm for the life of the instance. With min-instances>0
// an idle dev instance can take a request every few minutes; without this, the
// 30s TTL guarantees that almost every such request pays the auth-service hop
// (observed 0.19–0.53s warm, 4.1s cold) inside the request. The timer obeys the
// same nextRetryAt/inFlight guards, so an auth-service outage is still retried
// at most every 5s, not on every tick.
let keepFreshTimer = null;

function refreshInBackground() {
  if (cachedFlags && Date.now() < nextRetryAt) return;
  if (!inFlight) inFlight = refreshFlags().finally(() => { inFlight = null; });
}

export function warmFeatureFlags({ env = process.env } = {}) {
  if (env.NODE_ENV === 'test' || env.NODE_TEST_CONTEXT || !env.K_SERVICE) return null;
  let warm;
  try { warm = Promise.resolve(getFeatureFlags()).catch(() => {}); } catch { return null; }
  if (!keepFreshTimer) {
    keepFreshTimer = setInterval(refreshInBackground, FLAG_CACHE_TTL_MS / 2);
    keepFreshTimer.unref?.();
  }
  return warm;
}
void warmFeatureFlags();
