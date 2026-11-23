// Client platform/app version for server-emitted analytics events.
//
// The customer/partner apps send `x-app-platform` (ios|android|web) and
// `x-app-version` on every API request; the gateway forwards them untouched
// (it only strips x-user-* and x-internal-key). They are client-supplied, so
// only values that match a strict allow-list are ever used; anything else is
// dropped and the event simply carries no platform.

const PLATFORMS = new Set(['ios', 'android', 'web']);
const VERSION_RE = /^[0-9]+(\.[0-9]+)*$/;

function headerValue(headers, name) {
  const raw = headers?.[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {Record<string, string | string[] | undefined>} [headers] lower-cased request headers
 * @returns {{platform?: string, app_version?: string}} props to spread into an event
 */
export function clientAnalyticsProps(headers) {
  const out = {};
  const platform = headerValue(headers, 'x-app-platform').toLowerCase();
  if (PLATFORMS.has(platform)) out.platform = platform;
  const version = headerValue(headers, 'x-app-version');
  if (version.length > 0 && version.length <= 20 && VERSION_RE.test(version)) out.app_version = version;
  return out;
}
