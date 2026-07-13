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

// Cheap pre-filter before the exact haversine pass: a lat/lng box that fully
// contains the radius circle (over-includes near the corners, which the
// haversine pass then trims). Degrees-per-km approximation, fine at this
// radius scale (tens of km) — not meant to be precise.
export function boundingBox(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1);
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
  };
}

// Never expose a buddy's exact distance — bucketed so repeated swipes from
// different vantage points can't be used to triangulate a home location.
const DISTANCE_BUCKETS = [
  { maxKm: 1, label: '< 1 km' },
  { maxKm: 3, label: '1–3 km' },
  { maxKm: 5, label: '3–5 km' },
  { maxKm: 10, label: '5–10 km' },
];

export function bucketDistanceKm(distanceKm) {
  const bucket = DISTANCE_BUCKETS.find((b) => distanceKm < b.maxKm);
  return bucket ? bucket.label : '10+ km';
}
