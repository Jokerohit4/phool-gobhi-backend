import { PrismaClient } from '@prisma/client';
import * as placesService from './placesService.js';

const prisma = new PrismaClient();

// How close two coordinates must be, in metres, before we treat a Places
// result as "this is the partner gym we already have". Gyms sit in buildings,
// Places pins and our own partner-entered coordinates disagree by a few tens
// of metres routinely, and the failure modes are asymmetric:
//   too tight  -> we create an unclaimed row shadowing a real partner gym, and
//                 that customer silently loses booking/PAYG for a gym we sell.
//   too loose  -> we attach them to the wrong gym in a dense market.
// 150m is deliberately conservative; the name check below is what stops the
// loose case from mattering in a mall with four gyms in it.
const MATCH_RADIUS_M = 150;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Loose name comparison: lowercase, strip punctuation and the filler words
// every gym name contains, so "Gold's Gym (Sector 39)" and "Golds Gym Sector
// 39" compare equal without a fuzzy-match dependency.
const FILLER = new Set(['gym', 'fitness', 'centre', 'center', 'studio', 'the', 'and']);
function nameTokens(name) {
  return new Set(
    String(name || '')
      .toLowerCase()
      // Apostrophes are ELIDED, not turned into separators: splitting on them
      // makes "Gold's" two tokens ("gold", "s") while "Golds" stays one, so
      // the same gym written two ways would fail to match itself.
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !FILLER.has(t))
  );
}

function namesLookAlike(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  // Every distinguishing token of the smaller name must appear in the larger.
  return shared === Math.min(ta.size, tb.size);
}

/// Does this Places result correspond to a gym we already have as a partner?
///
/// Runs server-side on purpose: the client must not need to know our partner
/// list to decide, and the matching rule must be changeable without an app
/// release. Returns the matching Gym id, or null.
///
/// Both conditions must hold — near AND named alike. Distance alone puts a
/// mall's four gyms in one bucket; name alone matches a chain's other branch
/// across the city, which would attribute attendance to a gym the customer
/// has never entered.
export async function matchPartnerGymService({ name, lat, lng }) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  // Bounding box first so this is an indexed-ish scan rather than a full
  // table haversine. ~0.002 degrees latitude is comfortably wider than
  // MATCH_RADIUS_M at Indian latitudes.
  const delta = 0.002;
  const candidates = await prisma.gym.findMany({
    where: {
      lat: { gte: lat - delta, lte: lat + delta },
      lng: { gte: lng - delta, lte: lng + delta },
    },
    select: { id: true, name: true, lat: true, lng: true },
  });

  for (const g of candidates) {
    if (distanceMeters(lat, lng, g.lat, g.lng) > MATCH_RADIUS_M) continue;
    if (!namesLookAlike(name, g.name)) continue;
    return g.id;
  }
  return null;
}

/// Resolve a Places id into either "this is partner gym N" or an UnclaimedGym
/// row. Details are fetched server-side so no Maps key ever ships to a client.
export async function resolvePlaceService(placeId, userId, sessionToken) {
  if (!placeId) throw { status: 400, error: 'placeId is required' };

  const details = await placesService.placeDetails(placeId, sessionToken);
  if (details.lat === null || details.lng === null) {
    throw { status: 422, error: "That place has no location we can use for check-in." };
  }

  const matchedGymId = await matchPartnerGymService(details);
  if (matchedGymId) {
    return { matchedGymId, unclaimedGym: null };
  }

  const unclaimedGym = await prisma.unclaimedGym.upsert({
    where: { googlePlaceId: placeId },
    // Refresh the descriptive fields (a place can be renamed or re-pinned)
    // but never reassign addedByUserId — it records who told us first, which
    // is the interesting fact for sales, not who asked most recently.
    update: {
      name: details.name,
      address: details.address,
      city: details.city,
      lat: details.lat,
      lng: details.lng,
    },
    create: {
      googlePlaceId: placeId,
      name: details.name,
      address: details.address,
      city: details.city,
      lat: details.lat,
      lng: details.lng,
      addedByUserId: userId,
    },
  });

  return { matchedGymId: null, unclaimedGym };
}

export async function getUnclaimedGymService(id) {
  const gym = await prisma.unclaimedGym.findUnique({ where: { id } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  return gym;
}

export async function listUnclaimedGymsService({ claimStatus } = {}) {
  return prisma.unclaimedGym.findMany({
    where: claimStatus ? { claimStatus } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateClaimStatusService(id, { claimStatus, claimedGymId }) {
  await getUnclaimedGymService(id);
  return prisma.unclaimedGym.update({
    where: { id },
    data: {
      ...(claimStatus ? { claimStatus } : {}),
      ...(claimedGymId !== undefined ? { claimedGymId } : {}),
    },
  });
}
