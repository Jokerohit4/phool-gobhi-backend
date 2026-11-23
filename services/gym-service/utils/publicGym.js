// Single place that decides what a gym looks like to the PUBLIC and to
// customers (GET /api/gyms and GET /api/gyms/:id).
//
// Those two routes are public at the gateway (PUBLIC_ROUTES): the gateway
// strips x-user-id / x-user-role on public routes and never derives identity
// from a bearer token there, so gym-service cannot tell an anonymous caller
// from a customer, an owner or an admin. Every caller therefore gets this
// public view. Owners read their full row from GET /partner/mine and gobhi
// staff from GET /admin/all and GET /admin/:id, which are authenticated and
// role-gated.
//
// ALLOWLIST, not a deny-list: a column added to the Gym model later stays
// private until someone deliberately adds it here.
//
// Deliberately NOT exposed: brandDocs (verification documents), commissionPct
// and the subscription commission/pricing-mode/flat-fee columns (what the
// platform charges each partner), partnershipStartDate, rejectionReason,
// quotedPrice (customer apps derive their own struck-through price),
// attendanceSaasOptedOut, marketplaceEnabled, isApproved (always true on a
// public result), partnerId (internal owner user id), googlePlaceId, and
// timestamps.

const PUBLIC_GYM_FIELDS = [
  'id',
  'name',
  'description',
  'address',
  'city',
  'state',
  'lat',
  'lng',
  'amenities',
  'phone',
  'sessionPrice',
  'established',
  'openTime',
  'closeTime',
  'slotDuration',
  'capacity',
  'rating',
  'ratingCount',
  'googleRating',
  'googleRatingCount',
  'equipmentRating',
  'equipmentRatingCount',
  'cleanlinessRating',
  'cleanlinessRatingCount',
  'trainerRating',
  'trainerRatingCount',
  'valueForMoneyRating',
  'valueForMoneyRatingCount',
  'staffBehaviourRating',
  'staffBehaviourRatingCount',
  'crowdRating',
  'crowdRatingCount',
  'isActive',
  // Subscription plan prices are shown to customers
  // (GET /:id/subscription-plans); the commission on them is not.
  'weeklyPlanPrice',
  'monthlyPlanPrice',
  'quarterlyPlanPrice',
  'sixMonthlyPlanPrice',
  'yearlyPlanPrice',
  // Computed per request, not a column.
  'distanceKm',
];

const PUBLIC_IMAGE_FIELDS = ['id', 'url', 'mediaType'];

export function toPublicGym(gym) {
  if (!gym || typeof gym !== 'object') return gym;
  const out = {};
  for (const field of PUBLIC_GYM_FIELDS) {
    if (field in gym) out[field] = gym[field];
  }
  if (Array.isArray(gym.images)) {
    out.images = gym.images.map((img) => {
      const pub = {};
      for (const f of PUBLIC_IMAGE_FIELDS) if (f in img) pub[f] = img[f];
      return pub;
    });
  }
  // Recent reviews ride along on gym detail; they are already the public
  // review shape (same rows GET /:id/reviews returns).
  if (Array.isArray(gym.reviews)) out.reviews = gym.reviews;
  return out;
}

export function toPublicGyms(gyms) {
  return Array.isArray(gyms) ? gyms.map(toPublicGym) : gyms;
}
