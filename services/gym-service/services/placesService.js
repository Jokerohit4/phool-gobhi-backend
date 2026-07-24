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

export async function autocomplete(input, sessionToken) {
  const key = requireApiKey();
  const params = new URLSearchParams({
    input,
    key,
    components: 'country:in',
  });
  if (sessionToken) params.set('sessiontoken', sessionToken);

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

export async function placeDetails(placeId, sessionToken) {
  const key = requireApiKey();
  const params = new URLSearchParams({
    place_id: placeId,
    key,
    fields: 'name,formatted_address,geometry,address_component',
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
    name: result.name || '',
    address: result.formatted_address || '',
    city,
    lat: result.geometry?.location?.lat ?? null,
    lng: result.geometry?.location?.lng ?? null,
  };
}
