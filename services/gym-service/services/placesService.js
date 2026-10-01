// Server-side proxy for Google's legacy Places API — the key lives only in
// this service's env (Secret Manager), never sent to any client. Mirrors
// the same REST endpoints the Flutter partner app's google_maps_webservice
// package calls directly today, so this is a drop-in replacement for that
// client-side usage once the app is pointed here instead.
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

function requireApiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw { status: 500, error: 'Places API is not configured' };
  }
  return key;
}

export async function autocomplete(input, sessionToken, location) {
  const key = requireApiKey();
  const params = new URLSearchParams({
    input,
    key,
    components: 'country:in',
  });
  if (sessionToken) params.set('sessiontoken', sessionToken);
  // Biases ranking toward the caller's location without excluding matches
  // elsewhere (unlike `location`+`radius`, `locationbias` is a soft ranking
  // signal) — without it Places has no sense of where the partner actually
  // is and ranks by string match alone, e.g. "Sector 14" resolving to
  // whichever Sector 14 Google likes best nationwide.
  if (location) params.set('locationbias', `circle:50000@${location.lat},${location.lng}`);

  const res = await fetch(`${PLACES_BASE}/autocomplete/json?${params}`);
  const body = await res.json();
  if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
    throw { status: 502, error: body.error_message || `Places autocomplete failed (${body.status})` };
  }
  return (body.predictions || []).map((p) => ({
    placeId: p.place_id,
    description: p.description,
  }));
}

// Straight-line distance, rounded to the metre. Duplicated from
// unclaimedGymService rather than imported so this module stays a pure
// Places proxy with no Prisma import chain.
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// How far a typed search looks around the user. Wide enough to cover a whole
// metro (Gurugram ↔ south Delhi is ~25 km), narrow enough that "golds" means
// the Gold's Gym down the road, not one in Kalyan.
export const GYM_SEARCH_RADIUS_M = 30000;
// The no-query "gyms near you" list is about where they are standing.
export const GYM_NEARBY_RADIUS_M = 5000;
const GYM_TYPES = new Set(['gym', 'fitness_center']);

/// Gyms only, near the user — for the "I train at my own gym" picker.
///
/// Why not reuse autocomplete(): autocomplete predicts ADDRESSES. Asked for
/// "golds" it happily returned a canteen in Goa and a housing society in Mira
/// Road (seen on a real device, 2026-10-01). Legacy Text Search accepts
/// `type=gym`, which restricts results to places Google classifies as gyms,
/// and returns coordinates in the same call, so distance needs no Details
/// round-trip. Same legacy Places API product (and key) as autocomplete and
/// details, so nothing new has to be enabled in GCP.
///
/// With no query it falls back to Nearby Search (also `type=gym`) so the
/// picker's empty state can show "gyms near you" before anyone types.
///
/// `location` is optional: without it a typed search is still gym-only, just
/// not near anyone in particular (the user declined location).
export async function searchGyms({ query, location } = {}) {
  const key = requireApiKey();
  const q = typeof query === 'string' ? query.trim() : '';
  const hasLoc =
    location && Number.isFinite(location.lat) && Number.isFinite(location.lng);

  let url;
  if (q) {
    const params = new URLSearchParams({ query: q, type: 'gym', region: 'in', key });
    if (hasLoc) {
      // Text Search treats location+radius as a strong bias, not a hard
      // fence — a uniquely-named gym further out can still surface.
      params.set('location', `${location.lat},${location.lng}`);
      params.set('radius', String(GYM_SEARCH_RADIUS_M));
    }
    url = `${PLACES_BASE}/textsearch/json?${params}`;
  } else {
    if (!hasLoc) return []; // nothing to anchor "near you" to
    const params = new URLSearchParams({
      location: `${location.lat},${location.lng}`,
      radius: String(GYM_NEARBY_RADIUS_M),
      type: 'gym',
      key,
    });
    url = `${PLACES_BASE}/nearbysearch/json?${params}`;
  }

  const res = await fetch(url);
  const body = await res.json();
  if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
    throw { status: 502, error: body.error_message || `Gym search failed (${body.status})` };
  }

  const results = (body.results || [])
    // Belt and braces: `type=gym` should already guarantee this, but a stray
    // non-gym in this list is exactly the bug being fixed, so check again.
    .filter((r) => Array.isArray(r.types) && r.types.some((t) => GYM_TYPES.has(t)))
    .map((r) => {
      const lat = r.geometry?.location?.lat ?? null;
      const lng = r.geometry?.location?.lng ?? null;
      return {
        placeId: r.place_id,
        name: r.name || '',
        // Text Search returns formatted_address; Nearby returns vicinity.
        address: r.formatted_address || r.vicinity || '',
        lat,
        lng,
        distanceMeters:
          hasLoc && lat !== null && lng !== null
            ? haversineMeters(location.lat, location.lng, lat, lng)
            : null,
      };
    });

  // Nearest first when we know where the user is; otherwise keep Google's
  // relevance order.
  if (hasLoc) results.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
  return results.slice(0, 20);
}

export async function placeDetails(placeId, sessionToken) {
  const key = requireApiKey();
  const params = new URLSearchParams({
    place_id: placeId,
    key,
    // rating/user_ratings_total pull this call into Google's Atmosphere-Data
    // SKU (billed differently than the address-only Basic-Data fields below)
    // — needed so gym create/edit and the partner refresh button can read a
    // gym's Google rating without a second API call.
    fields: 'name,formatted_address,geometry,address_component,rating,user_ratings_total',
  });
  if (sessionToken) params.set('sessiontoken', sessionToken);

  const res = await fetch(`${PLACES_BASE}/details/json?${params}`);
  const body = await res.json();
  if (body.status !== 'OK') {
    throw { status: 502, error: body.error_message || `Place details failed (${body.status})` };
  }

  const result = body.result || {};
  const components = result.address_components || [];
  const city =
    components.find((c) => c.types.includes('locality'))?.long_name ||
    components.find((c) => c.types.includes('administrative_area_level_2'))?.long_name ||
    '';

  return {
    placeId,
    name: result.name || '',
    address: result.formatted_address || '',
    city,
    lat: result.geometry?.location?.lat ?? null,
    lng: result.geometry?.location?.lng ?? null,
    googleRating: result.rating ?? null,
    googleRatingCount: result.user_ratings_total ?? null,
  };
}
