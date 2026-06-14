// Vendor-neutral, fire-and-forget server-side event tracking.
//
// The sink is chosen by the ANALYTICS_PROVIDER env var:
//   'none'    (default) — no-op; safe to ship before analytics is configured
//   'console'           — logs each event as JSON (use in dev to verify the funnel)
//   'posthog'           — POSTs to PostHog's free HTTP capture API (no SDK dependency)
//
// Design rules:
//   - track() NEVER throws and NEVER blocks the request path (fire-and-forget).
//   - We send userId as distinct_id and avoid PII (no phone/email/name in properties).
//   - Swapping to a first-party Postgres sink later means adding one branch here;
//     no call site changes.
const PROVIDER = (process.env.ANALYTICS_PROVIDER || 'none').toLowerCase();
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const POSTHOG_KEY = process.env.POSTHOG_API_KEY || '';
const SERVICE = process.env.ANALYTICS_SERVICE_NAME || 'backend';

async function sendToPostHog(event, distinctId, properties) {
  if (!POSTHOG_KEY) return;
  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: String(distinctId ?? 'anonymous'),
        properties: { ...properties, source: 'server', service: SERVICE },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('[analytics] posthog send failed:', err.message);
  }
}

/**
 * Record a server-truth event. Safe to call anywhere — failures are swallowed.
 * @param {string} event       snake_case event name (see docs/ANALYTICS.md)
 * @param {string|number} distinctId  the user id this event belongs to
 * @param {object} [properties]  contextual properties (no PII)
 */
export function track(event, distinctId, properties = {}) {
  try {
    if (PROVIDER === 'none') return;
    if (PROVIDER === 'console') {
      console.log(
        `[analytics] ${event} ` +
          JSON.stringify({ distinct_id: String(distinctId ?? 'anonymous'), source: 'server', service: SERVICE, ...properties })
      );
      return;
    }
    if (PROVIDER === 'posthog') {
      // intentionally not awaited — never block the request
      sendToPostHog(event, distinctId, properties);
    }
  } catch (err) {
    console.error('[analytics] track failed:', err.message);
  }
}

export default { track };
