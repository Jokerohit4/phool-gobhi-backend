// Leaf module (imports nothing from services/controllers) so every writer of a
// cached setting can evict without creating an import cycle.
import { createTtlCache } from './ttlCache.js';

// DB-derived pieces of GET /app-config: version config blob, OTP provider,
// profile-completion bonus, social switch. Never holds anything that depends on
// the caller's app/platform/version — that comparison stays per request.
export const appConfigBundleCache = createTtlCache(15_000);
export const APP_CONFIG_KEY = 'bundle';

// Launch-gate row behind GET /launch-status.
export const launchGateCache = createTtlCache(15_000);
export const LAUNCH_GATE_KEY = 'gate';

// Every admin write to appVersionSetting / otpProviderSetting /
// profileCompletionBonusSetting must call this.
export function evictAppConfigBundle() {
  appConfigBundleCache.evict(APP_CONFIG_KEY);
}
export function evictLaunchGate() {
  launchGateCache.evict(LAUNCH_GATE_KEY);
}
