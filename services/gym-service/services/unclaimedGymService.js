import { randomUUID } from 'node:crypto';
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

// Manually added gyms carry a synthetic googlePlaceId so the existing unique
// column (and every consumer keyed on it) keeps working with no migration.
// The prefix is the marker: anything starting with it was pinned by a
// customer standing somewhere, not verified against Google's index — so a
// check-in there proves "the phone was where the user said their gym is",
// which is weaker evidence than a Places-backed gym. Anything that grades
// attendance (e.g. an insurer-grade score) must treat these as self-reported.
export const MANUAL_PLACE_PREFIX = 'manual:';

// Rough India bounding box. A manual pin outside it is a spoofed or broken
// location, not a gym we can geofence.
const INDIA_BOUNDS = { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5 };

export function isManualPlaceId(placeId) {
  return typeof placeId === 'string' && placeId.startsWith(MANUAL_PLACE_PREFIX);
}

/// "Can't find your gym? Add it" — the user names the gym and we pin it where
/// their phone is right now (they are expected to be at it). Partner matching
/// still runs first: a user who types "Iron House" while standing in our
/// partner Iron House should be sent to booking, not filed as independent.
export async function addManualGymService({ name, lat, lng }, userId) {
  const cleanName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (cleanName.length < 2 || cleanName.length > 80) {
    throw { status: 400, error: 'Gym name must be 2–80 characters' };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw { status: 400, error: 'Your current location is needed to add a gym' };
  }
  if (
    lat < INDIA_BOUNDS.minLat || lat > INDIA_BOUNDS.maxLat ||
    lng < INDIA_BOUNDS.minLng || lng > INDIA_BOUNDS.maxLng
  ) {
    throw { status: 422, error: 'That location is outside India' };
  }

  const matchedGymId = await matchPartnerGymService({ name: cleanName, lat, lng });
  if (matchedGymId) return { matchedGymId, unclaimedGym: null };

  // Reuse this user's own earlier manual pin of the same name close by, so
  // re-adding (e.g. after reinstalling) doesn't litter the table with
  // duplicates of one gym.
  const delta = 0.002;
  const mine = await prisma.unclaimedGym.findMany({
    where: {
      addedByUserId: userId,
      googlePlaceId: { startsWith: MANUAL_PLACE_PREFIX },
      lat: { gte: lat - delta, lte: lat + delta },
      lng: { gte: lng - delta, lte: lng + delta },
    },
  });
  const existing = mine.find(
    (g) => distanceMeters(lat, lng, g.lat, g.lng) <= MATCH_RADIUS_M && namesLookAlike(cleanName, g.name)
  );
  if (existing) return { matchedGymId: null, unclaimedGym: existing };

  const unclaimedGym = await prisma.unclaimedGym.create({
    data: {
      googlePlaceId: `${MANUAL_PLACE_PREFIX}${randomUUID()}`,
      name: cleanName,
      address: '',
      city: '',
      lat,
      lng,
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
