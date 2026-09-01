// Location enforcement for the challenges feature. The business rule (see
// the customer app's API contract) is that a challenge is only ever shown
// to, or joinable by, a user within a 20km radius of the challenge's anchor
// coordinates (Challenge.lat/lng). Enforced server-side off the gateway-
// forwarded x-user-lat/x-user-lng headers — the Flutter customer app already
// attaches these on every request (lib/core/api/api_client.dart), the same
// trust model gym-service uses for its 40km discovery cutoff.
export const MAX_CHALLENGE_DISTANCE_KM = 20;

// Same haversine formula gym-service uses (services/gymService.js) — this
// repo's convention is to duplicate the formula per service, not share it.
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Rounded-km distance from a user to a challenge's anchor, or null when the
// challenge has no coordinates (can't be confirmed within range).
export function distanceKmFromUser(userLat, userLng, challenge) {
  if (challenge?.lat == null || challenge?.lng == null) return null;
  return Math.round(haversineKm(userLat, userLng, challenge.lat, challenge.lng) * 10) / 10;
}

export function isWithinMaxChallengeRange(userLat, userLng, challenge) {
  const distanceKm = distanceKmFromUser(userLat, userLng, challenge);
  return distanceKm != null && distanceKm <= MAX_CHALLENGE_DISTANCE_KM;
}