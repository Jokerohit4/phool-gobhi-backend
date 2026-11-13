// Google's encoded-polyline format (precision 5, the same encoding
// gym-service's Places responses already use on the client side, but no
// decoder existed anywhere in this backend). Used only to recompute a run's
// distance server-side for the mismatch check in runService — never to
// render anything.
export function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = encoded.length;

  while (index < len) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMeters([lat1, lng1], [lat2, lng2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function encodeSignedNumber(num) {
  let sgnNum = num << 1;
  if (num < 0) sgnNum = ~sgnNum;
  let out = '';
  while (sgnNum >= 0x20) {
    out += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  return out + String.fromCharCode(sgnNum + 63);
}

export function encodePolyline(points) {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of points) {
    const lat5 = Math.round(lat * 1e5);
    const lng5 = Math.round(lng * 1e5);
    out += encodeSignedNumber(lat5 - prevLat) + encodeSignedNumber(lng5 - prevLng);
    prevLat = lat5;
    prevLng = lng5;
  }
  return out;
}

// Server-derived list-view thumbnail: a uniform downsample (never more than
// maxPoints), re-encoded. Deliberately not Douglas-Peucker here — that needs
// distance-to-line-segment math for shape-preserving simplification, and a
// history-list thumbnail rendered at ~46dp doesn't need shape-preserving,
// just "roughly the right route" at a tenth of the bytes.
export function thumbnailPolyline(encoded, maxPoints = 40) {
  const points = decodePolyline(encoded);
  if (points.length <= maxPoints) return encoded;
  const step = (points.length - 1) / (maxPoints - 1);
  const sampled = [];
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(points[Math.round(i * step)]);
  }
  return encodePolyline(sampled);
}

// Sum of consecutive point-to-point distances along a decoded polyline —
// same measure the client's own recorder uses (run-tracker-spec.html §07),
// so a route that round-trips cleanly through encode/decode reproduces the
// client's own number rather than drifting from it.
export function polylineDistanceMeters(encoded) {
  const points = decodePolyline(encoded);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}
