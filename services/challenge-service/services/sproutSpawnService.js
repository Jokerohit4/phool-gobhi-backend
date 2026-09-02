import { PrismaClient } from '@prisma/client';
import { creditCoinsService } from './coinLedgerService.js';
const prisma = new PrismaClient();

// Wave 2 — wild Sprout spawns for a challenge's live map (see
// sprint2/explore-map-wave2-pokemongo-redesign-spec.html §8/§12-13). Species
// catalog is a small static list, not a table — same reasoning Wave 1 used to
// avoid a Badge table: it's reference data, not data that changes shape.
// `Gobhi King` (legendary) is deliberately excluded — it's a Community Day-
// only spawn per the spec, not a default wild one.
export const SPROUT_SPECIES = [
  { key: 'floret_pup', name: 'Floret Pup', archetype: 'General fitness', rarity: 'common', coinValue: 5 },
  { key: 'iron_floret', name: 'Iron Floret', archetype: 'Strength training', rarity: 'uncommon', coinValue: 15 },
  { key: 'cardio_sprig', name: 'Cardio Sprig', archetype: 'Cardio / endurance', rarity: 'uncommon', coinValue: 15 },
  { key: 'zen_stalk', name: 'Zen Stalk', archetype: 'Yoga / mobility', rarity: 'rare', coinValue: 40 },
];

const SPAWN_TTL_MS = 25 * 60 * 1000; // 25 min — matches spec §13's 20-30 min window
const MIN_LIVE_SPAWNS = 2;
const MAX_LIVE_SPAWNS = 3;
const CATCH_RADIUS_METERS = 60;
const JITTER_DEGREES = 0.003; // ~150-300m at typical launch-city latitudes

// Same haversine formula as challengeEnrollmentService's checkpoint geofence
// — duplicated per-service by this repo's own convention, not shared.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pickSpecies() {
  return SPROUT_SPECIES[Math.floor(Math.random() * SPROUT_SPECIES.length)];
}

function jitter() {
  return (Math.random() - 0.5) * 2 * JITTER_DEGREES;
}

function serialize(spawn) {
  const species = SPROUT_SPECIES.find((s) => s.key === spawn.speciesKey);
  return {
    id: spawn.id,
    speciesKey: spawn.speciesKey,
    speciesName: species?.name || spawn.speciesKey,
    archetype: species?.archetype || null,
    rarity: spawn.rarity,
    lat: spawn.lat,
    lng: spawn.lng,
    expiresAt: spawn.expiresAt,
  };
}

// Seeded lazily on read rather than a background job — same "cheapest slice
// that proves the mechanic" posture Wave 1 used for badges. Anchors new
// spawns around the challenge's checkpoint spots (city-quest challenges) or
// the caller's own location (gym-native challenges, which have none).
export async function getNearbySproutsService(challengeId, { lat, lng } = {}) {
  const challenge = await prisma.challenge.findUnique({
    where: { id: Number(challengeId) },
    include: { checkpointSpots: true },
  });
  if (!challenge) throw { status: 404, error: 'Challenge not found' };

  const now = new Date();
  const live = await prisma.sproutSpawn.findMany({
    where: { challengeId: challenge.id, expiresAt: { gt: now }, caughtByUserId: null },
  });
  if (live.length >= MIN_LIVE_SPAWNS) return live.map(serialize);

  const anchors = challenge.checkpointSpots.length > 0
    ? challenge.checkpointSpots.map((s) => ({ lat: s.lat, lng: s.lng }))
    : (typeof lat === 'number' && typeof lng === 'number' ? [{ lat, lng }] : []);
  if (anchors.length === 0) return live.map(serialize);

  const toCreate = MAX_LIVE_SPAWNS - live.length;
  const created = [];
  for (let i = 0; i < toCreate; i++) {
    const anchor = anchors[Math.floor(Math.random() * anchors.length)];
    const species = pickSpecies();
    // eslint-disable-next-line no-await-in-loop -- small (<=3), sequential is fine and simpler than Promise.all here
    const spawn = await prisma.sproutSpawn.create({
      data: {
        challengeId: challenge.id,
        speciesKey: species.key,
        rarity: species.rarity,
        coinValue: species.coinValue,
        lat: anchor.lat + jitter(),
        lng: anchor.lng + jitter(),
        expiresAt: new Date(now.getTime() + SPAWN_TTL_MS),
      },
    });
    created.push(spawn);
  }
  return [...live, ...created].map(serialize);
}

// Server-authoritative catch: re-validates proximity and spawn state before
// paying out, exactly like visitCheckpointService re-validates the geofence
// rather than trusting the client's "I'm there" claim. Never throws for an
// already-gone spawn (raced or expired) — that's a normal outcome ("it got
// away"), not an error, same non-error-for-benign-outcome convention as
// creditWorkoutInternal.
export async function catchSproutService(userId, challengeId, spawnId, { lat, lng }) {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw { status: 400, error: 'lat and lng are required' };
  }
  const spawn = await prisma.sproutSpawn.findUnique({ where: { id: Number(spawnId) } });
  if (!spawn || spawn.challengeId !== Number(challengeId)) {
    throw { status: 404, error: 'Unknown Sprout spawn for this challenge' };
  }
  if (spawn.caughtByUserId || spawn.expiresAt <= new Date()) {
    return { caught: false };
  }

  const distance = distanceMeters(lat, lng, spawn.lat, spawn.lng);
  if (distance > CATCH_RADIUS_METERS) {
    throw {
      status: 400,
      error: "You're too far from this Sprout to catch it",
      code: 'TOO_FAR',
      distance: Math.round(distance),
    };
  }

  // Atomic claim — loses gracefully to a concurrent catch attempt on the same
  // spawn instead of double-paying (same updateMany-with-where-guard pattern
  // as coinLedgerService.debitCoinsService's balance check).
  const { count } = await prisma.sproutSpawn.updateMany({
    where: { id: spawn.id, caughtByUserId: null },
    data: { caughtByUserId: userId, caughtAt: new Date() },
  });
  if (count === 0) return { caught: false };

  const species = SPROUT_SPECIES.find((s) => s.key === spawn.speciesKey);
  const balance = await creditCoinsService(
    userId,
    spawn.coinValue,
    `Caught a wild Sprout (${spawn.speciesKey})`,
    `sprout-catch:${spawn.id}`,
  );

  return {
    caught: true,
    speciesKey: spawn.speciesKey,
    speciesName: species?.name || spawn.speciesKey,
    rarity: spawn.rarity,
    coinsAwarded: spawn.coinValue,
    balance,
  };
}
