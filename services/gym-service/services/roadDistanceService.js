// Real driving-distance labels for gym listings, via OpenRouteService's free
// Matrix API — haversine (in gymService.js) is what actually filters/sorts
// gym discovery; this is layered on afterward purely to make the displayed
// "X km away" number match what a user would see on a map, not a business
// rule. Any failure here (missing key, network, ORS error, quota) is
// non-fatal: callers get back whatever gyms it could resolve and are
// expected to fall back to their own haversine value for the rest.
const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';

// GPS jitter shifts lat/lng by tens of meters between reads of the "same"
// spot — rounding to 3 decimals (~111m) buckets those together without
// meaningfully changing a 40km-scale displayed distance.
const CACHE_PRECISION = 3;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Keyed by rounded "lat,lng" -> { gymIdsKey, distances, expiresAt }. Kept
// in-process only (Cloud Run can run several instances, so hit rate isn't
// perfect fleet-wide) — a shared cache is only worth the added infra if ORS
// quota or hit rate actually becomes a problem, not preemptively.
const cache = new Map();

function roundCoord(n) {
  return Number(n.toFixed(CACHE_PRECISION));
}

/**
 * Returns a Map<gymId, distanceKm> of real driving distances from
 * (userLat, userLng) to each gym in `gyms` ({id, lat, lng}[]). Gyms ORS
 * couldn't route to — or every gym, on any request-level failure — are
 * simply absent from the returned map.
 */
export async function getRoadDistancesKm(userLat, userLng, gyms) {
  if (gyms.length === 0) return new Map();

  const key = `${roundCoord(userLat)},${roundCoord(userLng)}`;
  const gymIdsKey = gyms.map((g) => g.id).sort((a, b) => a - b).join(',');
  const cached = cache.get(key);
  if (cached && cached.gymIdsKey === gymIdsKey && cached.expiresAt > Date.now()) {
    return cached.distances;
  }

  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) return new Map();

  try {
    const res = await fetch(ORS_MATRIX_URL, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // ORS locations are [lng, lat], not [lat, lng].
        locations: [[userLng, userLat], ...gyms.map((g) => [g.lng, g.lat])],
        sources: [0],
        destinations: gyms.map((_, i) => i + 1),
        metrics: ['distance'],
      }),
    });
    if (!res.ok) return new Map();

    const body = await res.json();
    const row = body?.distances?.[0];
    if (!Array.isArray(row)) return new Map();

    const distances = new Map();
    gyms.forEach((gym, i) => {
      const meters = row[i];
      if (typeof meters === 'number') {
        distances.set(gym.id, Math.round((meters / 1000) * 10) / 10);
      }
    });

    cache.set(key, { gymIdsKey, distances, expiresAt: Date.now() + CACHE_TTL_MS });
    return distances;
  } catch {
    return new Map();
  }
}
