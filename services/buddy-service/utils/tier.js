// Premium-gating hook for discovery filters. Not enforced on any filter yet
// (product hasn't decided which ones become premium-only) — this is the
// plumbing so that flipping a filter to premium-only later is a one-line
// change (set minTier below) plus assertTierAllows() at the call site,
// rather than a rework. Reads req.headers['x-user-type'], which the gateway
// already forwards from the verified JWT on every proxied request — no
// extra call to auth-service needed.
const TIER_ORDER = ['general', 'sub_premium', 'premium'];

export function isTierAtLeast(userType, minTier) {
  if (!minTier) return true;
  const have = TIER_ORDER.indexOf(userType);
  const need = TIER_ORDER.indexOf(minTier);
  if (need === -1) return true;
  return have >= need;
}

// Per-filter minimum tier. All null today — update here when a filter
// becomes premium-only.
export const FILTER_SPECS = {
  radiusKm: { minTier: null },
  genders: { minTier: null },
  fitnessGoals: { minTier: null },
  ageRange: { minTier: null },
};

export function assertTierAllows(userType, filterKey) {
  const spec = FILTER_SPECS[filterKey];
  if (!spec || isTierAtLeast(userType, spec.minTier)) return;
  throw { status: 403, error: `The "${filterKey}" filter requires a ${spec.minTier} plan` };
}
