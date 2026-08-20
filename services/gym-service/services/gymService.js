import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary.js';
import { generateTimeSlots, generateWindowedSlots } from '../utils/slots.js';
import { getDayOfWeek } from '../utils/slotTiming.js';
import * as placesService from './placesService.js';
import { getRoadDistancesKm } from './roadDistanceService.js';

const prisma = new PrismaClient();

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Gym's price fields (plus commissionPct, same Decimal column type) are
// Decimal in Postgres (see schema.prisma) — Prisma returns them as Decimal
// objects, which JS silently mishandles in plain arithmetic (comparing two
// Decimals with </> does a STRING compare; `decimalObj + number` can
// string-concatenate instead of adding). Every function below runs its
// fetched/created/updated gym through this immediately after the Prisma
// call, before any further JS touches it, so the rest of this file (and
// every service that reads a gym from gym-service's API) only ever sees
// plain numbers — same convention as wallet-service's Number(...) wrapping.
const GYM_MONEY_FIELDS = [
  'sessionPrice', 'quotedPrice', 'weeklyPlanPrice', 'monthlyPlanPrice', 'quarterlyPlanPrice', 'sixMonthlyPlanPrice', 'yearlyPlanPrice',
  'commissionPct', 'subscriptionCommissionPct',
];
function normalizeGymMoney(gym) {
  if (!gym) return gym;
  const out = { ...gym };
  for (const f of GYM_MONEY_FIELDS) {
    if (out[f] != null) out[f] = Number(out[f]);
  }
  return out;
}

const SUBSCRIPTION_PLANS = [
  { planType: 'weekly', field: 'weeklyPlanPrice', days: 7 },
  { planType: 'monthly', field: 'monthlyPlanPrice', days: 30 },
  { planType: 'quarterly', field: 'quarterlyPlanPrice', days: 90 },
  { planType: 'sixMonthly', field: 'sixMonthlyPlanPrice', days: 182 },
  { planType: 'yearly', field: 'yearlyPlanPrice', days: 365 },
];

// Validates the fields that flow into slot generation (utils/slots.js). A
// non-positive slotDuration in particular isn't just bad data — it makes
// generateTimeSlots loop forever, since its termination check assumes a
// positive step. Called with the FINAL values that will actually be stored
// (post-defaulting on create), not the raw request body.
function validateGymFields({ sessionPrice, quotedPrice, capacity, slotDuration, openTime, closeTime }) {
  if (sessionPrice !== undefined && (typeof sessionPrice !== 'number' || !(sessionPrice > 0))) {
    throw { status: 400, error: 'sessionPrice must be a positive number' };
  }
  if (quotedPrice !== undefined && quotedPrice !== null && (typeof quotedPrice !== 'number' || !(quotedPrice > 0))) {
    throw { status: 400, error: 'quotedPrice must be a positive number' };
  }
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity <= 0)) {
    throw { status: 400, error: 'capacity must be a positive integer' };
  }
  if (slotDuration !== undefined && (!Number.isInteger(slotDuration) || slotDuration <= 0)) {
    throw { status: 400, error: 'slotDuration must be a positive integer number of minutes' };
  }
  if (openTime !== undefined && !TIME_RE.test(openTime)) {
    throw { status: 400, error: 'openTime must be in HH:MM 24-hour format' };
  }
  if (closeTime !== undefined && !TIME_RE.test(closeTime)) {
    throw { status: 400, error: 'closeTime must be in HH:MM 24-hour format' };
  }
  if (openTime !== undefined && closeTime !== undefined && TIME_RE.test(openTime) && TIME_RE.test(closeTime)) {
    const [oh, om] = openTime.split(':').map(Number);
    const [ch, cm] = closeTime.split(':').map(Number);
    if (oh * 60 + om >= ch * 60 + cm) {
      throw { status: 400, error: 'closeTime must be after openTime' };
    }
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
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

// Gyms further than this from the user are not shown in the list at all —
// a business rule, not just a sort/display concern.
const MAX_DISTANCE_KM = 40;

// Orderings for GET /api/gyms ?sort=. The sort param lets the customer app's
// home feed render genuinely different lists per tab instead of re-sorting one
// client-side copy: "rating" (Top Rated), "popular" (Popular, ratingCount =
// number of reviews as the closest popularity proxy available), "recommended"
// (a reputation blend so it isn't just a rehash of the other three), and
// "distance" (Near You). The default (no sort) preserves the historical
// behavior — distance-sorted when a location is attached, else DB order.
//
// Sort fallback: a gym's own aggregate rating wins once it has in-app reviews;
// until then the Google rating (if any) stands in, so a well-rated new gym
// isn't buried at the bottom of the rating-based tabs. This only affects
// ordering — the response still carries the raw rating/ratingCount and the
// separate googleRating/googleRatingCount fields, which the app already shows
// side by side.
const byDistanceKm = (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
const sortRating = (g) => (g.ratingCount > 0 && g.rating != null ? g.rating : (g.googleRating ?? 0));
const sortRatingCount = (g) => (g.ratingCount > 0 ? g.ratingCount : (g.googleRatingCount ?? 0));

export async function listGyms({ city, minPrice, maxPrice, search, amenities, sort, userLat, userLng }) {
  const where = {
    isActive: true,
    isApproved: true,
  };

  if (city) {
    where.city = {
      mode: 'insensitive',
      contains: city,
    };
  }

  if (minPrice !== undefined) {
    where.sessionPrice = {
      gte: minPrice,
    };
  }

  if (maxPrice !== undefined) {
    if (where.sessionPrice) {
      where.sessionPrice.lte = maxPrice;
    } else {
      where.sessionPrice = {
        lte: maxPrice,
      };
    }
  }

  if (search) {
    where.OR = [
      {
        name: {
          mode: 'insensitive',
          contains: search,
        },
      },
      {
        address: {
          mode: 'insensitive',
          contains: search,
        },
      },
    ];
  }

  let gyms = (await prisma.gym.findMany({
    where,
    include: { images: { orderBy: { id: 'asc' } } },
  })).map(normalizeGymMoney);

  if (amenities) {
    const amenitiesArray = amenities.split(',').map(a => a.trim());
    gyms = gyms.filter(gym =>
      amenitiesArray.every(amenity => gym.amenities.includes(amenity))
    );
  }

  if (userLat != null && userLng != null) {
    gyms = gyms
      .map(gym => ({
        ...gym,
        distanceKm:
          gym.lat != null && gym.lng != null
            ? Math.round(haversineKm(userLat, userLng, gym.lat, gym.lng) * 10) / 10
            : null,
      }))
      // Gyms without coordinates can't be confirmed within range, so they're
      // dropped along with anything beyond MAX_DISTANCE_KM.
      .filter(gym => gym.distanceKm != null && gym.distanceKm <= MAX_DISTANCE_KM);
  }

  if (sort === 'rating') {
    gyms.sort((a, b) =>
      (sortRating(b) - sortRating(a)) ||
      (sortRatingCount(b) - sortRatingCount(a)) ||
      byDistanceKm(a, b)
    );
  } else if (sort === 'popular') {
    gyms.sort((a, b) =>
      (sortRatingCount(b) - sortRatingCount(a)) ||
      (sortRating(b) - sortRating(a)) ||
      byDistanceKm(a, b)
    );
  } else if (sort === 'recommended') {
    gyms.sort((a, b) =>
      ((sortRating(b) * sortRatingCount(b)) - (sortRating(a) * sortRatingCount(a))) ||
      byDistanceKm(a, b)
    );
  } else if (userLat != null && userLng != null) {
    // Default and 'distance' both end here: nearest first.
    gyms.sort(byDistanceKm);
  }

  // Filtering/sorting above is deliberately straight-line (cheap, always
  // available, fine for a "roughly in range" business rule). Swap in real
  // driving distance only for what's actually displayed, without touching
  // the order already established above — a river or highway loop can make
  // road distance rank differently than straight-line, but re-sorting on it
  // isn't worth an external call becoming load-bearing for page order.
  if (userLat != null && userLng != null) {
    const roadDistances = await getRoadDistancesKm(userLat, userLng, gyms);
    gyms = gyms.map(gym => ({
      ...gym,
      distanceKm: roadDistances.get(gym.id) ?? gym.distanceKm,
    }));
  }

  return gyms;
}

// Admin (gobhi) listing — unlike listGyms above, this has no isActive/
// isApproved filter by default so staff can see gyms pending review.
export async function listGymsAdmin({ status, partnerId } = {}) {
  const where = {};

  if (status === 'pending') {
    where.isApproved = false;
    where.rejectionReason = null;
  } else if (status === 'rejected') {
    where.isApproved = false;
    where.rejectionReason = { not: null };
  } else if (status === 'approved') {
    where.isApproved = true;
  }

  // Staff viewing "this partner's other gyms" wants every one of that
  // partner's gyms regardless of status, not just the currently-selected tab.
  if (partnerId) {
    where.partnerId = Number(partnerId);
  }

  const gyms = await prisma.gym.findMany({
    where,
    include: { images: { orderBy: { id: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  return gyms.map(normalizeGymMoney);
}

// True nearest-gym distance for a lat/lng, with NO MAX_DISTANCE_KM cutoff —
// unlike listGyms (a business rule: don't show gyms beyond 40km), this is
// purely descriptive, used only by the website's location_resolved analytics
// event so the admin's Location Reach view can tell "visitor's nearest gym is
// 62km away" apart from "visitor never shared location," which listGyms's
// silent filtering can't distinguish. Real driving distance (getRoadDistancesKm)
// where available — straight-line haversine understates how far a visitor
// genuinely has to travel, which is the whole point of this endpoint.
export async function getNearestGymDistance(userLat, userLng) {
  // lat/lng are non-nullable Float columns (schema.prisma) — Prisma rejects
  // an explicit `{ not: null }` filter on a required field, so (as in
  // listGyms above) there's nothing to filter here beyond isActive/isApproved.
  const gyms = await prisma.gym.findMany({
    where: { isActive: true, isApproved: true },
    select: { id: true, lat: true, lng: true },
  });

  const roadDistances = await getRoadDistancesKm(userLat, userLng, gyms);

  let nearest = null;
  for (const gym of gyms) {
    const distanceKm =
      roadDistances.get(gym.id) ?? Math.round(haversineKm(userLat, userLng, gym.lat, gym.lng) * 10) / 10;
    if (nearest === null || distanceKm < nearest.distanceKm) {
      nearest = { gymId: gym.id, distanceKm };
    }
  }

  return { nearestGymId: nearest?.gymId ?? null, nearestDistanceKm: nearest?.distanceKm ?? null };
}

export async function getGymById(id, userLat, userLng) {
  const gym = normalizeGymMoney(await prisma.gym.findUnique({
    where: { id },
    include: { images: { orderBy: { id: 'asc' } }, reviews: true },
  }));

  if (!gym || !gym.isActive || !gym.isApproved) {
    throw { status: 404, error: 'Gym not found' };
  }

  if (userLat != null && userLng != null && gym.lat != null && gym.lng != null) {
    const haversineDistanceKm = Math.round(haversineKm(userLat, userLng, gym.lat, gym.lng) * 10) / 10;
    const roadDistances = await getRoadDistancesKm(userLat, userLng, [{ id: gym.id, lat: gym.lat, lng: gym.lng }]);
    return {
      ...gym,
      distanceKm: roadDistances.get(gym.id) ?? haversineDistanceKm,
    };
  }

  return gym;
}


export async function getGymByIdRaw(id) {
  const gym = await prisma.gym.findUnique({
    where: { id },
    include: { images: { orderBy: { id: 'asc' } } },
  });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  return normalizeGymMoney(gym);
}

export async function getGymCapacity(id) {
  const gym = await prisma.gym.findUnique({
    where: { id },
    select: {
      capacity: true,
      slotDuration: true,
      openTime: true,
      closeTime: true,
    },
  });

  if (!gym) {
    throw { status: 404, error: 'Gym not found' };
  }

  return gym;
}

// Best-effort — a partner creating/editing their gym must never be blocked
// by Google Places being down or slow, so failures here are swallowed and
// just leave the google* fields unset (the partner can still hit the
// dedicated refresh endpoint later, which does surface errors).
async function fetchGoogleRatingFields(placeId) {
  if (!placeId) return {};
  try {
    const d = await placesService.placeDetails(placeId);
    return {
      googleRating: d.googleRating,
      googleRatingCount: d.googleRatingCount,
      googleRatingUpdatedAt: new Date(),
    };
  } catch (_) {
    return {};
  }
}

export async function createGym(partnerId, data) {
  const {
    name,
    description,
    address,
    city,
    state,
    lat,
    lng,
    amenities,
    phone,
    sessionPrice,
    quotedPrice,
    weeklyPlanPrice,
    monthlyPlanPrice,
    quarterlyPlanPrice,
    sixMonthlyPlanPrice,
    yearlyPlanPrice,
    established,
    brandDocs,
    openTime,
    closeTime,
    slotDuration,
    capacity,
    googlePlaceId,
  } = data;

  const finalSlotDuration = slotDuration || 60;
  const finalCapacity = capacity || 20;
  validateGymFields({
    sessionPrice,
    quotedPrice,
    capacity: finalCapacity,
    slotDuration: finalSlotDuration,
    openTime,
    closeTime,
  });

  const googleFields = await fetchGoogleRatingFields(googlePlaceId);

  const gym = await prisma.gym.create({
    data: {
      partnerId,
      name,
      description,
      address,
      city,
      state,
      lat,
      lng,
      amenities: amenities || [],
      phone,
      sessionPrice,
      quotedPrice: quotedPrice ?? null,
      weeklyPlanPrice: weeklyPlanPrice ?? null,
      monthlyPlanPrice: monthlyPlanPrice ?? null,
      quarterlyPlanPrice: quarterlyPlanPrice ?? null,
      sixMonthlyPlanPrice: sixMonthlyPlanPrice ?? null,
      yearlyPlanPrice: yearlyPlanPrice ?? null,
      established: established ?? null,
      brandDocs: brandDocs || [],
      openTime,
      closeTime,
      slotDuration: finalSlotDuration,
      capacity: finalCapacity,
      isApproved: false,
      isActive: true,
      googlePlaceId: googlePlaceId || null,
      ...googleFields,
    },
  });

  // Seed all 7 days with a single morning window reproducing openTime/
  // closeTime — same convention as the backfill migration for pre-existing
  // gyms, so getOperatingHours never needs its fallback for a gym created
  // after this feature shipped. The partner can split/vary this later via
  // the operating-hours editor.
  await prisma.gymOperatingHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      gymId: gym.id, dayOfWeek, morningStart: openTime, morningEnd: closeTime,
    })),
  });

  return normalizeGymMoney(gym);
}

// The actual write for a profile-field change — shared by updateGym (gym not
// yet approved: applies immediately) and approveEditRequest (gym approved:
// applies once a gobhi signs off on the pending request built from the same
// payload shape).
async function applyGymProfileUpdate(gymId, updateData) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });

  // Re-linking to a different (or first-time) Google place should show the
  // new place's rating immediately, without waiting for a separate refresh
  // click. Untouched saves (googlePlaceId unchanged) skip the extra API call.
  if ('googlePlaceId' in updateData && updateData.googlePlaceId !== gym.googlePlaceId) {
    Object.assign(updateData, await fetchGoogleRatingFields(updateData.googlePlaceId));
  }

  const updated = normalizeGymMoney(await prisma.gym.update({
    where: { id: gymId },
    data: updateData,
  }));

  // Changing slotDuration shifts every day's slot boundaries (openTime/
  // closeTime no longer drive slot generation directly — see
  // GymOperatingHours below — but slotDuration remains one global value per
  // gym), which can orphan GymSlotPrice rows whose startTime no longer
  // occurs on any day. Clear those out so stale prices don't silently linger.
  if ('slotDuration' in updateData) {
    const validStartTimes = [...(await getAllPossibleStartTimes(gymId)).keys()];
    await prisma.gymSlotPrice.deleteMany({
      where: { gymId, startTime: { notIn: validStartTimes } },
    });
  }

  return updated;
}

export async function updateGym(gymId, partnerId, data) {
  const gym = normalizeGymMoney(await prisma.gym.findUnique({
    where: { id: gymId },
  }));

  if (!gym) {
    throw { status: 404, error: 'Gym not found' };
  }

  if (gym.partnerId !== partnerId) {
    throw { status: 403, error: 'Forbidden' };
  }

  const updateData = {};
  const allowedFields = [
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
    'quotedPrice',
    'established',
    'brandDocs',
    'openTime',
    'closeTime',
    'slotDuration',
    'capacity',
    'weeklyPlanPrice',
    'monthlyPlanPrice',
    'quarterlyPlanPrice',
    'sixMonthlyPlanPrice',
    'yearlyPlanPrice',
    // Lets a partner reactivate a gym that was deactivated via DELETE
    // /:id (softDeleteGym) — that route only ever sets isActive=false,
    // with no corresponding endpoint to flip it back until now. Partner's
    // own on/off switch — applied immediately below, never gated behind an
    // edit request, since there's nothing to "review" about pulling your
    // own listing offline.
    'isActive',
    'googlePlaceId',
    // Partner's own opt-out of the attendance-SaaS program — same
    // immediate-apply, never-gated treatment as isActive just above, and
    // for the same reason: nothing customer-facing to review about a
    // partner declining a commission program.
    'attendanceSaasOptedOut',
  ];

  allowedFields.forEach(field => {
    if (field in data) {
      updateData[field] = data[field];
    }
  });

  validateGymFields(updateData);

  const { isActive, attendanceSaasOptedOut, ...gatedData } = updateData;

  let updatedGym = gym;
  if (isActive !== undefined || attendanceSaasOptedOut !== undefined) {
    updatedGym = normalizeGymMoney(await prisma.gym.update({
      where: { id: gymId },
      data: {
        ...(isActive !== undefined && { isActive }),
        ...(attendanceSaasOptedOut !== undefined && { attendanceSaasOptedOut }),
      },
    }));
  }

  if (Object.keys(gatedData).length === 0) {
    return updatedGym;
  }

  // Once a gym is live, a partner's edit no longer writes straight to
  // customer-facing data — it becomes a pending request a gobhi must
  // approve, and the old approved version keeps showing until then. A gym
  // that has never been approved yet (still in initial review, or being
  // fixed up after rejection) has nothing live to protect, so it keeps
  // applying directly, same as always.
  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'profile', gatedData);
    return { pending: true, editRequest };
  }

  const applied = await applyGymProfileUpdate(gymId, gatedData);

  // Editing a rejected gym is an implicit "I fixed it" — worth another look,
  // so clear the stale rejection reason rather than leaving it displayed
  // next to what might now be a compliant listing.
  if (gym.rejectionReason) {
    await prisma.gym.update({ where: { id: gymId }, data: { rejectionReason: null } });
    applied.rejectionReason = null;
  }

  return applied;
}

// Unlike fetchGoogleRatingFields (used inline during create/update, where a
// Places failure must never block saving the gym), this is the explicit
// "Refresh Google Rating" button — its whole point is telling the partner
// whether it worked, so failures propagate instead of being swallowed.
export async function refreshGoogleRating(gymId, partnerId) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });

  if (!gym) {
    throw { status: 404, error: 'Gym not found' };
  }

  if (gym.partnerId !== partnerId) {
    throw { status: 403, error: 'Forbidden' };
  }

  if (!gym.googlePlaceId) {
    throw { status: 400, error: 'This gym is not linked to a Google listing yet — re-select your address on the gym page.' };
  }

  const details = await placesService.placeDetails(gym.googlePlaceId);
  const updated = await prisma.gym.update({
    where: { id: gymId },
    data: {
      googleRating: details.googleRating,
      googleRatingCount: details.googleRatingCount,
      googleRatingUpdatedAt: new Date(),
    },
  });

  return normalizeGymMoney(updated);
}

export async function softDeleteGym(gymId, partnerId) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
  });

  if (!gym) {
    throw { status: 404, error: 'Gym not found' };
  }

  if (gym.partnerId !== partnerId) {
    throw { status: 403, error: 'Forbidden' };
  }

  const deleted = await prisma.gym.update({
    where: { id: gymId },
    data: { isActive: false },
  });

  return normalizeGymMoney(deleted);
}

// Admin (gobhi) soft-delete/restore — no ownership check, unlike
// softDeleteGym above which only a gym's own partner can hit. Reversible
// (isActive: true undoes it), so this is the safe default for admin
// removals; hard-deleting (below) is only for gyms with zero booking history.
export async function setGymActiveAdmin(gymId, isActive) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };

  const updated = await prisma.gym.update({
    where: { id: gymId },
    data: { isActive },
  });
  return normalizeGymMoney(updated);
}

// Admin (gobhi) hard delete — permanently removes the gym row. Images,
// reviews, slot prices and edit requests cascade via this schema's
// onDelete: Cascade, but bookings live in booking-service's own DB with no
// FK enforcement across services, so the caller (deleteGymAdmin controller)
// must confirm zero booking history first — see its booking-count check.
export async function deleteGymAdmin(gymId) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };

  await prisma.gym.delete({ where: { id: gymId } });
}

export async function getPartnerGyms(partnerId) {
  const gyms = await prisma.gym.findMany({
    where: { partnerId },
    include: { images: { orderBy: { id: 'asc' } } },
  });

  return gyms.map(normalizeGymMoney);
}

// Compact onboarding summary for a partner — does a gym exist yet, and is it
// approved. Used by auth-service to tell the partner app, at login, where to
// route (dashboard vs. resume onboarding) without trusting local state.
// Counts every gym the partner has ever created, active or not: a soft-deleted
// or admin-deactivated gym is still a real gym, and a partner who has one
// should land on their dashboard (to manage/reactivate it) rather than being
// funneled into creating a brand-new gym at login.
export async function getPartnerGymSummary(partnerId) {
  const gyms = await prisma.gym.findMany({
    where: { partnerId },
    orderBy: { id: 'asc' },
    select: { id: true, isApproved: true, rejectionReason: true },
  });
  // "approved" answers "does this partner have AT LEAST ONE approved gym" —
  // a partner with 2+ gyms should route to their dashboard even if their
  // very first gym was rejected, as long as a later one is live. gymId/
  // rejectionReason still resolve to one sensible "primary" gym (prefer an
  // approved one) so a client that only reads those two fields keeps
  // working unmodified.
  const approvedGym = gyms.find(g => g.isApproved);
  const primary = approvedGym || gyms[0];
  return {
    hasGym: gyms.length > 0,
    approved: !!approvedGym,
    gymId: primary?.id ?? null,
    rejectionReason: approvedGym ? null : (primary?.rejectionReason ?? null),
    gymCount: gyms.length,
    hasOtherGyms: gyms.length > 1,
  };
}

// Cloudinary upload already happened by the time either of these run (the
// caller needs the URL either way) — what's gated is only the DB row that
// makes the photo/doc show up on the live gym.
async function applyGymImageAdd(gymId, { url, publicId, mediaType }) {
  return prisma.gymImage.create({ data: { gymId, url, publicId, mediaType: mediaType || 'image' } });
}

async function applyGymImageDelete({ imageId }) {
  const image = await prisma.gymImage.findUnique({ where: { id: imageId } });
  if (!image) {
    throw { status: 404, error: 'Image not found' };
  }

  if (image.publicId) {
    try {
      // Cloudinary scopes destroy by resource_type (defaults to 'image') —
      // omitting this for a video silently no-ops instead of deleting it.
      await cloudinary.uploader.destroy(image.publicId, {
        resource_type: image.mediaType === 'video' ? 'video' : 'image',
      });
    } catch (err) {
      console.error('Error deleting image from Cloudinary:', err.message);
    }
  }

  await prisma.gymImage.delete({ where: { id: imageId } });
  return { message: 'Image deleted' };
}

export async function addGymImage(gymId, partnerId, url, publicId, mediaType = 'image') {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
  });

  if (!gym) {
    throw { status: 404, error: 'Gym not found' };
  }

  if (gym.partnerId !== partnerId) {
    throw { status: 403, error: 'Forbidden' };
  }

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'image_add', { url, publicId, mediaType });
    return { pending: true, editRequest };
  }

  return applyGymImageAdd(gymId, { url, publicId, mediaType });
}

export async function deleteGymImage(gymId, imageId, partnerId) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
  });

  if (!gym) {
    throw { status: 404, error: 'Gym not found' };
  }

  if (gym.partnerId !== partnerId) {
    throw { status: 403, error: 'Forbidden' };
  }

  const image = await prisma.gymImage.findUnique({ where: { id: imageId } });
  if (!image) {
    throw { status: 404, error: 'Image not found' };
  }

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'image_delete', { imageId });
    return { pending: true, editRequest };
  }

  return applyGymImageDelete({ imageId });
}

// Derive a Cloudinary public id from a delivery URL, e.g.
// https://res.cloudinary.com/<cloud>/image/upload/v123/phool-gobhi/docs/abc.pdf
// -> phool-gobhi/docs/abc
function cloudinaryPublicIdFromUrl(url) {
  try {
    const match = String(url).match(/\/upload\/(?:v\d+\/)?(.+)$/);
    if (!match) return null;
    return match[1].replace(/\.[^/.]+$/, '');
  } catch {
    return null;
  }
}

async function applyGymDocAdd(gymId, { url }) {
  const updated = await prisma.gym.update({
    where: { id: gymId },
    data: { brandDocs: { push: url } },
    select: { brandDocs: true },
  });
  return updated.brandDocs;
}

async function applyGymDocDelete(gymId, { url }) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { brandDocs: true } });
  const remaining = (gym?.brandDocs || []).filter((d) => d !== url);

  // Best-effort Cloudinary cleanup. brandDocs stores only URLs, so derive the
  // public id; resource_type 'auto'/raw uploads need to be destroyed as such.
  const publicId = cloudinaryPublicIdFromUrl(url);
  if (publicId) {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch (err) {
      console.error('Error deleting doc from Cloudinary:', err.message);
    }
  }

  const updated = await prisma.gym.update({
    where: { id: gymId },
    data: { brandDocs: { set: remaining } },
    select: { brandDocs: true },
  });
  return updated.brandDocs;
}

export async function addGymDoc(gymId, partnerId, url) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'doc_add', { url });
    return { pending: true, editRequest };
  }

  return applyGymDocAdd(gymId, { url });
}

export async function deleteGymDoc(gymId, partnerId, url) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'doc_delete', { url });
    return { pending: true, editRequest };
  }

  return applyGymDocDelete(gymId, { url });
}

// Optional per-review category scores — a customer can rate any subset, so
// each category's average AND count are tracked independently (unlike the
// overall rating/ratingCount, which always has one count for the whole gym).
const CATEGORY_FIELDS = [
  'equipmentRating',
  'cleanlinessRating',
  'trainerRating',
  'valueForMoneyRating',
  'staffBehaviourRating',
  'crowdRating',
];

// One aggregate() round trip computes avg+non-null-count for the overall
// rating and every category at once — `_count: { field: true }` counts only
// non-null values for that field, distinct from `_count._all` (all rows).
async function recomputeGymRating(tx, gymId) {
  const aggregate = await tx.gymReview.aggregate({
    where: { gymId },
    _avg: { rating: true, ...Object.fromEntries(CATEGORY_FIELDS.map((f) => [f, true])) },
    _count: { _all: true, ...Object.fromEntries(CATEGORY_FIELDS.map((f) => [f, true])) },
  });

  const data = {
    rating: aggregate._count._all > 0 ? aggregate._avg.rating : null,
    ratingCount: aggregate._count._all,
  };
  for (const field of CATEGORY_FIELDS) {
    data[field] = aggregate._count[field] > 0 ? aggregate._avg[field] : null;
    data[`${field}Count`] = aggregate._count[field];
  }

  await tx.gym.update({ where: { id: gymId }, data });
}

export async function addReview(gymId, customerId, rating, comment, categories = {}) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
  });

  if (!gym || !gym.isActive || !gym.isApproved) {
    throw { status: 404, error: 'Gym not found' };
  }

  const categoryData = {};
  for (const field of CATEGORY_FIELDS) {
    if (categories[field] != null) categoryData[field] = categories[field];
  }

  const review = await prisma.$transaction(async (tx) => {
    const created = await tx.gymReview.create({
      data: {
        gymId,
        customerId,
        rating,
        comment,
        ...categoryData,
      },
    });

    await recomputeGymRating(tx, gymId);

    return created;
  });

  return review;
}

// Admin-only moderation — removes a fake/abusive review and recomputes the
// gym's rating so it doesn't keep reflecting a review nobody can see anymore.
export async function deleteReview(gymId, reviewId) {
  const review = await prisma.gymReview.findUnique({ where: { id: reviewId } });
  if (!review || review.gymId !== gymId) {
    throw { status: 404, error: 'Review not found' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.gymReview.delete({ where: { id: reviewId } });
    await recomputeGymRating(tx, gymId);
  });
}

export async function getGymReviews(gymId) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym || !gym.isActive || !gym.isApproved) {
    throw { status: 404, error: 'Gym not found' };
  }

  const reviews = await prisma.gymReview.findMany({
    where: { gymId },
    orderBy: { createdAt: 'desc' },
  });

  return reviews;
}

export async function approveGym(gymId, { approved = true, reason = null } = {}) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };

  if (!approved && !reason) {
    throw { status: 400, error: 'A reason is required when rejecting a gym' };
  }

  return normalizeGymMoney(await prisma.gym.update({
    where: { id: gymId },
    data: {
      isApproved: approved,
      rejectionReason: approved ? null : reason,
      // First approval only — a later reject/re-approve cycle must not reset
      // the honeymoon clock the gym already started.
      ...(approved && !gym.partnershipStartDate ? { partnershipStartDate: new Date() } : {}),
    },
  }));
}

// gobhi-only — unlike updateGym (partner-owned, allowlisted material
// fields), this never checks partnerId: commission is a platform lever an
// admin sets on any gym, not something the owning partner can touch.
export async function updateGymCommission(gymId, commissionPct) {
  if (typeof commissionPct !== 'number' || Number.isNaN(commissionPct) || commissionPct < 0 || commissionPct > 100) {
    throw { status: 400, error: 'commissionPct must be a number between 0 and 100' };
  }
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };

  return normalizeGymMoney(await prisma.gym.update({
    where: { id: gymId },
    data: { commissionPct },
  }));
}

// gobhi-only, same shape as updateGymCommission — overrides the
// attendance-SaaS post-honeymoon rate wallet-service applies to this gym's
// GymSubscription purchases (see computeSubscriptionSaasCommissionPct).
// null resets to the platform default instead of a fixed number.
export async function updateGymSubscriptionCommission(gymId, subscriptionCommissionPct) {
  if (
    subscriptionCommissionPct !== null &&
    (typeof subscriptionCommissionPct !== 'number' || Number.isNaN(subscriptionCommissionPct) || subscriptionCommissionPct < 0 || subscriptionCommissionPct > 100)
  ) {
    throw { status: 400, error: 'subscriptionCommissionPct must be a number between 0 and 100, or null to reset to the platform default' };
  }
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };

  return normalizeGymMoney(await prisma.gym.update({
    where: { id: gymId },
    data: { subscriptionCommissionPct },
  }));
}

// Pending edit requests ------------------------------------------------------
// Once a gym is approved, the gated mutations above (updateGym's non-isActive
// fields, image/doc add-delete, slot prices, slot blocks) route here instead
// of writing live. A gobhi reviews the payload and either approves it (which
// dispatches to the same apply* function the mutation would have called
// directly on an unapproved gym) or rejects it (no live write at all).

// changeTypes that represent a single mutable draft (profile fields, the
// whole slot-price list) — a newer pending request here really does replace
// the old one, since there's only ever one "current" value being proposed.
// Anything else (image/doc add-delete, slot blocks) is a discrete event, not
// a state: uploading a second photo isn't a revision of the first upload,
// it's an independent addition, and superseding would silently drop it
// before a gobhi ever sees it — exactly what made "upload 3 photos, only the
// last one shows up for review" happen.
const SINGLETON_CHANGE_TYPES = new Set(['profile', 'slot_prices']);

async function createEditRequest(gymId, partnerId, changeType, payload) {
  if (SINGLETON_CHANGE_TYPES.has(changeType)) {
    // A partner is never blocked from resubmitting — the newest request for
    // a given (gym, changeType) simply supersedes whatever was still
    // pending, so duplicate pending rows never pile up and there's always
    // exactly one pending request per changeType to review.
    await prisma.gymEditRequest.updateMany({
      where: { gymId, changeType, status: 'pending' },
      data: { status: 'rejected', rejectionReason: 'Superseded by a newer request' },
    });
  }

  return prisma.gymEditRequest.create({
    data: { gymId, partnerId, changeType, payload },
  });
}

// Partner-facing: their own gym's request history (to show pending/rejected
// status banners) — ownership-checked the same way every other partner route is.
export async function getPartnerEditRequests(gymId, partnerId) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { partnerId: true } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  return prisma.gymEditRequest.findMany({
    where: { gymId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

export async function listEditRequestsAdmin({ status = 'pending' } = {}) {
  return prisma.gymEditRequest.findMany({
    where: { status },
    include: { gym: { select: { name: true, city: true, partnerId: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getEditRequestAdmin(id) {
  const request = await prisma.gymEditRequest.findUnique({
    where: { id },
    // Nested include, not just `gym: true` — an image_delete request's admin
    // detail page looks up gym.images.find(img => img.id === payload.imageId)
    // to show which photo is being removed, and a bare `gym: true` only
    // pulls the gym's own scalar fields, leaving gym.images undefined and
    // that .find() throwing.
    include: { gym: { include: { images: { orderBy: { id: 'asc' } } } } },
  });
  if (!request) throw { status: 404, error: 'Edit request not found' };
  request.gym = normalizeGymMoney(request.gym);
  return request;
}

export async function approveEditRequest(id, gobhiId) {
  const request = await prisma.gymEditRequest.findUnique({ where: { id } });
  if (!request) throw { status: 404, error: 'Edit request not found' };
  if (request.status !== 'pending') {
    throw { status: 400, error: `Edit request is already ${request.status}` };
  }

  // Atomically claim the request BEFORE applying any side effect. This is
  // what actually prevents two staff simultaneously approving and rejecting
  // the same request from both passing the pending check above: only one of
  // approveEditRequest/rejectEditRequest's claims can match status='pending'
  // on this row — the loser's count is 0 and it fails cleanly instead of one
  // side's mutation landing on the gym while the request ends up marked
  // decided the other way.
  const claim = await prisma.gymEditRequest.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'approved', reviewedBy: gobhiId, reviewedAt: new Date() },
  });
  if (claim.count === 0) {
    throw { status: 400, error: 'Edit request was already reviewed' };
  }

  try {
    switch (request.changeType) {
      case 'profile':
        await applyGymProfileUpdate(request.gymId, request.payload);
        break;
      case 'image_add':
        await applyGymImageAdd(request.gymId, request.payload);
        break;
      case 'image_delete':
        await applyGymImageDelete(request.payload);
        break;
      case 'doc_add':
        await applyGymDocAdd(request.gymId, request.payload);
        break;
      case 'doc_delete':
        await applyGymDocDelete(request.gymId, request.payload);
        break;
      case 'slot_prices':
        await applySlotPrices(request.gymId, request.payload.prices);
        break;
      case 'slot_block_add':
        await applySlotBlockAdd(request.gymId, request.payload);
        break;
      case 'slot_block_delete':
        await applySlotBlockDelete(request.payload);
        break;
      case 'operating_hours_update':
        await applyOperatingHoursUpdate(request.gymId, request.payload.days);
        break;
      case 'class_add':
        await applyClassAdd(request.gymId, request.payload);
        break;
      case 'class_update':
        await applyClassUpdate(request.payload);
        break;
      case 'class_delete':
        await applyClassDelete(request.payload);
        break;
      default:
        throw { status: 500, error: `Unknown edit request type: ${request.changeType}` };
    }
  } catch (err) {
    // The side effect failed after we already claimed 'approved' — revert
    // to pending so the request isn't stuck marked approved with nothing
    // actually applied, and a retry (or manual reject) is still possible.
    await prisma.gymEditRequest.updateMany({
      where: { id, status: 'approved' },
      data: { status: 'pending', reviewedBy: null, reviewedAt: null },
    }).catch(() => {});
    throw err;
  }

  return prisma.gymEditRequest.findUnique({ where: { id } });
}

export async function rejectEditRequest(id, gobhiId, reason) {
  if (!reason) {
    throw { status: 400, error: 'A reason is required when rejecting an edit request' };
  }

  const request = await prisma.gymEditRequest.findUnique({ where: { id } });
  if (!request) throw { status: 404, error: 'Edit request not found' };
  if (request.status !== 'pending') {
    throw { status: 400, error: `Edit request is already ${request.status}` };
  }

  // Same atomic claim as approveEditRequest — see there for why.
  const claim = await prisma.gymEditRequest.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'rejected', rejectionReason: reason, reviewedBy: gobhiId, reviewedAt: new Date() },
  });
  if (claim.count === 0) {
    throw { status: 400, error: 'Edit request was already reviewed' };
  }

  return prisma.gymEditRequest.findUnique({ where: { id } });
}

// Partner-facing: cancel their own still-pending request before a gobhi
// reviews it — e.g. they made a typo, or submitted a class on the wrong
// day. Ownership-checked the same way every other partner-facing mutation
// is; the atomic claim mirrors approveEditRequest/rejectEditRequest so a
// gobhi approving/rejecting at the same instant can't race this.
export async function withdrawEditRequest(id, partnerId) {
  const request = await prisma.gymEditRequest.findUnique({ where: { id } });
  if (!request) throw { status: 404, error: 'Edit request not found' };
  if (request.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };
  if (request.status !== 'pending') {
    throw { status: 400, error: `Edit request is already ${request.status}` };
  }

  const claim = await prisma.gymEditRequest.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'withdrawn', reviewedAt: new Date() },
  });
  if (claim.count === 0) {
    throw { status: 400, error: 'Edit request was already reviewed' };
  }

  return prisma.gymEditRequest.findUnique({ where: { id } });
}

export async function getAvailableSlots(gymId, date) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { openTime: true, closeTime: true, slotDuration: true, capacity: true, isApproved: true, isActive: true },
  });

  if (!gym || !gym.isActive || !gym.isApproved) {
    throw { status: 404, error: 'Gym not found' };
  }

  const blocks = await prisma.slotBlock.findMany({
    where: { gymId, date },
    select: { startTime: true, endTime: true },
  });

  const blockedTimes = new Set(blocks.map(b => b.startTime));

  return { gym, blockedTimes: [...blockedTimes] };
}

export async function getSlotBlocks(gymId, date) {
  return prisma.slotBlock.findMany({
    where: { gymId, ...(date ? { date } : {}) },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
}

async function applySlotBlockAdd(gymId, { date, startTime, endTime }) {
  // Prevent duplicate blocks
  const existing = await prisma.slotBlock.findFirst({
    where: { gymId, date, startTime },
  });
  if (existing) return existing;

  return prisma.slotBlock.create({
    data: { gymId, date, startTime, endTime },
  });
}

async function applySlotBlockDelete({ blockId }) {
  // deleteMany rather than delete — approval can run after the partner (or
  // another approval) already removed the same block, and that shouldn't
  // fail the approval.
  await prisma.slotBlock.deleteMany({ where: { id: blockId } });
  return { message: 'Block removed' };
}

export async function createSlotBlock(gymId, partnerId, { date, startTime, endTime }) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'slot_block_add', { date, startTime, endTime });
    return { pending: true, editRequest };
  }

  return applySlotBlockAdd(gymId, { date, startTime, endTime });
}

export async function deleteSlotBlock(blockId, partnerId) {
  const block = await prisma.slotBlock.findUnique({
    where: { id: blockId },
    include: { gym: { select: { id: true, partnerId: true, isApproved: true } } },
  });
  if (!block) throw { status: 404, error: 'Block not found' };
  if (block.gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (block.gym.isApproved) {
    const editRequest = await createEditRequest(block.gym.id, partnerId, 'slot_block_delete', { blockId });
    return { pending: true, editRequest };
  }

  return applySlotBlockDelete({ blockId });
}

export async function isSlotBlocked(gymId, date, startTime) {
  const block = await prisma.slotBlock.findFirst({
    where: { gymId, date, startTime },
  });
  return !!block;
}

// Per-day-of-week operating hours ------------------------------------------
// Up to two windows/day (morning + evening). Every gym gets exactly 7 rows
// (dayOfWeek 0-6) — created at gym-create time (see createGym) and
// backfilled for pre-existing gyms by the migration that introduced this
// model, reproducing the old single openTime/closeTime window exactly so
// nothing changes until a partner edits their hours.

function validateHoursRow({ dayOfWeek, morningStart, morningEnd, eveningStart, eveningEnd }) {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw { status: 400, error: 'dayOfWeek must be an integer 0-6' };
  }
  for (const [start, end, label] of [
    [morningStart, morningEnd, 'morning'],
    [eveningStart, eveningEnd, 'evening'],
  ]) {
    if ((start == null) !== (end == null)) {
      throw { status: 400, error: `${label} window must have both start and end, or neither (closed)` };
    }
    if (start != null) {
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
        throw { status: 400, error: `${label} window times must be in HH:MM 24-hour format` };
      }
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      if (sh * 60 + sm >= eh * 60 + em) {
        throw { status: 400, error: `${label} window end must be after its start` };
      }
    }
  }
  if (morningEnd && eveningStart) {
    const [meh, mem] = morningEnd.split(':').map(Number);
    const [esh, esm] = eveningStart.split(':').map(Number);
    if (esh * 60 + esm < meh * 60 + mem) {
      throw { status: 400, error: 'evening window must not start before the morning window ends' };
    }
  }
}

// One-release-cycle safety net: a gym should always have all 7
// GymOperatingHours rows (created at gym-create time, backfilled for
// pre-existing gyms by the migration), but if one is ever missing, fall back
// to the gym's legacy openTime/closeTime as a single morning window instead
// of silently showing "closed all day" — a missing row is a data bug, not a
// business decision that a gym is closed. Logged so the fallback firing in
// prod is visible; remove once confirmed there are zero hits.
export async function getOperatingHours(gymId, dayOfWeek) {
  const row = await prisma.gymOperatingHours.findUnique({
    where: { gymId_dayOfWeek: { gymId, dayOfWeek } },
  });
  if (row) return row;

  console.error(`[operating-hours-fallback] gymId=${gymId} dayOfWeek=${dayOfWeek} has no GymOperatingHours row — falling back to legacy openTime/closeTime`);
  const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { openTime: true, closeTime: true } });
  if (!gym) return null;
  return { gymId, dayOfWeek, morningStart: gym.openTime, morningEnd: gym.closeTime, eveningStart: null, eveningEnd: null };
}

export async function getAllOperatingHours(gymId) {
  const rows = await prisma.gymOperatingHours.findMany({ where: { gymId }, orderBy: { dayOfWeek: 'asc' } });
  if (rows.length === 7) return rows;

  const byDay = new Map(rows.map(r => [r.dayOfWeek, r]));
  const gym = await prisma.gym.findUnique({ where: { id: gymId }, select: { openTime: true, closeTime: true } });
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    if (byDay.has(dayOfWeek)) return byDay.get(dayOfWeek);
    console.error(`[operating-hours-fallback] gymId=${gymId} dayOfWeek=${dayOfWeek} has no GymOperatingHours row — falling back to legacy openTime/closeTime`);
    return { gymId, dayOfWeek, morningStart: gym?.openTime ?? null, morningEnd: gym?.closeTime ?? null, eveningStart: null, eveningEnd: null };
  });
}

// Union of every distinct startTime that could occur on ANY day of the
// week — this is what "a valid slot for pricing purposes" means now that
// windows vary by day (GymSlotPrice itself stays keyed only by startTime,
// same value whichever day it's used on).
export async function getAllPossibleStartTimes(gymId) {
  const gym = normalizeGymMoney(await prisma.gym.findUnique({ where: { id: gymId } }));
  if (!gym) throw { status: 404, error: 'Gym not found' };

  const hours = await getAllOperatingHours(gymId);
  const map = new Map();
  for (const h of hours) {
    for (const s of generateWindowedSlots(h, gym.slotDuration)) {
      if (!map.has(s.startTime)) map.set(s.startTime, s.endTime);
    }
  }
  return map;
}

async function applyOperatingHoursUpdate(gymId, days) {
  await prisma.$transaction(
    days.map(d => prisma.gymOperatingHours.upsert({
      where: { gymId_dayOfWeek: { gymId, dayOfWeek: d.dayOfWeek } },
      update: {
        morningStart: d.morningStart ?? null,
        morningEnd: d.morningEnd ?? null,
        eveningStart: d.eveningStart ?? null,
        eveningEnd: d.eveningEnd ?? null,
      },
      create: {
        gymId,
        dayOfWeek: d.dayOfWeek,
        morningStart: d.morningStart ?? null,
        morningEnd: d.morningEnd ?? null,
        eveningStart: d.eveningStart ?? null,
        eveningEnd: d.eveningEnd ?? null,
      },
    }))
  );

  // Same stale-price rationale as applyGymProfileUpdate's slotDuration
  // branch — changed windows can orphan GymSlotPrice rows whose startTime no
  // longer occurs on any day.
  const validStartTimes = [...(await getAllPossibleStartTimes(gymId)).keys()];
  await prisma.gymSlotPrice.deleteMany({ where: { gymId, startTime: { notIn: validStartTimes } } });

  return getAllOperatingHours(gymId);
}

export async function upsertOperatingHours(gymId, partnerId, days) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (!Array.isArray(days) || days.length !== 7) {
    throw { status: 400, error: 'days must be a complete array of all 7 days (dayOfWeek 0-6)' };
  }
  const seen = new Set();
  for (const d of days) {
    validateHoursRow(d);
    seen.add(d.dayOfWeek);
  }
  if (seen.size !== 7) {
    throw { status: 400, error: 'days must include each dayOfWeek 0-6 exactly once' };
  }

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'operating_hours_update', { days });
    return { pending: true, editRequest };
  }

  return applyOperatingHoursUpdate(gymId, days);
}

// Recurring bookable classes -------------------------------------------------
// A class held multiple times a week is multiple GymClass rows, one per
// dayOfWeek. price null = included with an active subscription at this gym
// (booking-service enforces this, see createBooking); price set = always
// charged that amount regardless of subscription status.

function validateClassFields({ name, dayOfWeek, startTime, endTime, capacity, price }) {
  if (typeof name !== 'string' || !name.trim()) {
    throw { status: 400, error: 'name is required' };
  }
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw { status: 400, error: 'dayOfWeek must be an integer 0-6' };
  }
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    throw { status: 400, error: 'startTime/endTime must be in HH:MM 24-hour format' };
  }
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if (sh * 60 + sm >= eh * 60 + em) {
    throw { status: 400, error: 'endTime must be after startTime' };
  }
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw { status: 400, error: 'capacity must be a positive integer' };
  }
  if (price !== undefined && price !== null && (typeof price !== 'number' || !(price > 0))) {
    throw { status: 400, error: 'price must be a positive number, or null/omitted to include with subscription' };
  }
}

function normalizeClass(cls) {
  return { ...cls, price: cls.price != null ? Number(cls.price) : null };
}

// Pure-DB lookup for getClassOccurrences (gymController.js) — the actual
// upcoming-dates computation + booking-service count fetch lives in the
// controller, mirroring getAnnotatedSlotsForDate's split (controller owns
// cross-service HTTP calls; this file stays DB-only).
export async function getClassForOccurrences(gymId, classId) {
  const cls = await prisma.gymClass.findUnique({ where: { id: classId }, include: { cancellations: true } });
  if (!cls || cls.gymId !== gymId || !cls.isActive) throw { status: 404, error: 'Class not found' };
  return { ...normalizeClass(cls), cancelledDates: cls.cancellations.map(c => c.date) };
}

export async function getGymClasses(gymId) {
  const rows = await prisma.gymClass.findMany({
    where: { gymId },
    include: { cancellations: { orderBy: { date: 'asc' } } },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });
  return rows.map(normalizeClass);
}

// Internal — consumed by booking-service when a customer books a class.
export async function getClassInternal(classId) {
  const cls = await prisma.gymClass.findUnique({
    where: { id: classId },
    include: { gym: { select: { isActive: true, isApproved: true } }, cancellations: true },
  });
  if (!cls) throw { status: 404, error: 'Class not found' };
  return {
    id: cls.id,
    gymId: cls.gymId,
    name: cls.name,
    dayOfWeek: cls.dayOfWeek,
    startTime: cls.startTime,
    endTime: cls.endTime,
    capacity: cls.capacity,
    price: cls.price != null ? Number(cls.price) : null,
    isActive: cls.isActive,
    gymIsActive: cls.gym.isActive,
    gymIsApproved: cls.gym.isApproved,
    cancelledDates: cls.cancellations.map(c => c.date),
  };
}

async function applyClassAdd(gymId, data) {
  return prisma.gymClass.create({
    data: {
      gymId,
      name: data.name,
      description: data.description ?? null,
      instructor: data.instructor ?? null,
      dayOfWeek: data.dayOfWeek,
      startTime: data.startTime,
      endTime: data.endTime,
      capacity: data.capacity,
      price: data.price ?? null,
      isActive: data.isActive ?? true,
    },
  });
}

// Ordinary field edits and one-off occurrence cancel/uncancel (e.g.
// "instructor sick on 2026-08-20") both flow through this same
// 'class_update' edit-request type — no separate enum value was needed for
// the low-blast-radius cancellation action, it's just distinguished by an
// `action` key in the payload.
async function applyClassUpdate({ classId, ...data }) {
  if (data.action === 'cancel_occurrence') {
    await prisma.gymClassCancellation.upsert({
      where: { classId_date: { classId, date: data.date } },
      update: {},
      create: { classId, date: data.date },
    });
    return prisma.gymClass.findUnique({ where: { id: classId } });
  }
  if (data.action === 'uncancel_occurrence') {
    await prisma.gymClassCancellation.deleteMany({ where: { classId, date: data.date } });
    return prisma.gymClass.findUnique({ where: { id: classId } });
  }

  const updateData = {};
  for (const f of ['name', 'description', 'instructor', 'dayOfWeek', 'startTime', 'endTime', 'capacity', 'price', 'isActive']) {
    if (f in data) updateData[f] = data[f];
  }
  return prisma.gymClass.update({ where: { id: classId }, data: updateData });
}

async function applyClassDelete({ classId }) {
  await prisma.gymClass.deleteMany({ where: { id: classId } });
  return { message: 'Class removed' };
}

export async function createClass(gymId, partnerId, data) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };
  validateClassFields(data);

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'class_add', data);
    return { pending: true, editRequest };
  }
  return normalizeClass(await applyClassAdd(gymId, data));
}

export async function updateClass(gymId, classId, partnerId, data) {
  const cls = await prisma.gymClass.findUnique({
    where: { id: classId },
    include: { gym: { select: { id: true, partnerId: true, isApproved: true } } },
  });
  if (!cls || cls.gymId !== gymId) throw { status: 404, error: 'Class not found' };
  if (cls.gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  const isCancellationAction = data.action === 'cancel_occurrence' || data.action === 'uncancel_occurrence';
  if (isCancellationAction) {
    if (!data.date) throw { status: 400, error: 'date is required' };
  } else {
    validateClassFields({ ...normalizeClass(cls), ...data });
  }

  if (cls.gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'class_update', { classId, ...data });
    return { pending: true, editRequest };
  }
  return normalizeClass(await applyClassUpdate({ classId, ...data }));
}

export async function deleteClass(gymId, classId, partnerId) {
  const cls = await prisma.gymClass.findUnique({
    where: { id: classId },
    include: { gym: { select: { id: true, partnerId: true, isApproved: true } } },
  });
  if (!cls || cls.gymId !== gymId) throw { status: 404, error: 'Class not found' };
  if (cls.gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (cls.gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'class_delete', { classId });
    return { pending: true, editRequest };
  }
  return applyClassDelete({ classId });
}

// Time-of-day slot pricing & subscription plans -----------------------------

// startTime -> price for every GymSlotPrice row on this gym. Used by
// getAnnotatedSlotsForDate to attach a resolved price per slot without
// regenerating the slot list or re-fetching the gym.
export async function getSlotPriceMap(gymId) {
  const rows = await prisma.gymSlotPrice.findMany({
    where: { gymId },
    select: { startTime: true, price: true },
  });
  return new Map(rows.map(r => [r.startTime, Number(r.price)]));
}

export async function getSlotPrices(gymId) {
  const gym = normalizeGymMoney(await prisma.gym.findUnique({ where: { id: gymId } }));
  if (!gym) throw { status: 404, error: 'Gym not found' };

  const validSlots = await getAllPossibleStartTimes(gymId);
  const priceMap = await getSlotPriceMap(gymId);

  return [...validSlots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([startTime, endTime]) => ({
      startTime,
      endTime,
      price: priceMap.has(startTime) ? priceMap.get(startTime) : gym.sessionPrice,
      isDefault: !priceMap.has(startTime),
    }));
}

// Re-derives valid slots from the gym as it looks RIGHT NOW rather than
// trusting whatever was valid when the request was submitted — hours/duration
// may have changed (via a separately-approved profile or hours edit) in the
// meantime.
async function applySlotPrices(gymId, prices) {
  const validSlots = await getAllPossibleStartTimes(gymId);

  await prisma.$transaction(
    prices
      .filter(p => validSlots.has(p.startTime))
      .map(p =>
        prisma.gymSlotPrice.upsert({
          where: { gymId_startTime: { gymId, startTime: p.startTime } },
          update: { price: p.price },
          create: { gymId, startTime: p.startTime, endTime: validSlots.get(p.startTime), price: p.price },
        })
      )
  );

  return getSlotPrices(gymId);
}

export async function upsertSlotPrices(gymId, partnerId, prices) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (!Array.isArray(prices) || prices.length === 0) {
    throw { status: 400, error: 'prices must be a non-empty array of {startTime, price}' };
  }

  const validSlots = await getAllPossibleStartTimes(gymId);

  for (const p of prices) {
    if (!validSlots.has(p.startTime)) {
      throw { status: 400, error: `${p.startTime} is not a valid slot for this gym` };
    }
    if (typeof p.price !== 'number' || !(p.price > 0)) {
      throw { status: 400, error: `price for slot ${p.startTime} must be a positive number` };
    }
  }

  if (gym.isApproved) {
    const editRequest = await createEditRequest(gymId, partnerId, 'slot_prices', { prices });
    return { pending: true, editRequest };
  }

  return applySlotPrices(gymId, prices);
}

// Resolves the price for one specific slot (falls back to sessionPrice),
// consumed by booking-service via GET /internal/:id?startTime=&date=. When
// both startTime and date are given, also resolves isValidSlot — whether
// startTime actually falls within that day's operating-hours windows — so
// booking-service can reject an out-of-hours booking attempt using the same
// internal gym-fetch it already makes at the start of createBooking, instead
// of a second round-trip.
export async function getGymInternalWithSlotPrice(gymId, startTime, date) {
  const gym = await getGymByIdRaw(gymId);

  let resolvedSlotPrice = gym.sessionPrice;
  if (startTime) {
    const row = await prisma.gymSlotPrice.findUnique({
      where: { gymId_startTime: { gymId, startTime } },
    });
    resolvedSlotPrice = row ? Number(row.price) : gym.sessionPrice;
  }

  let isValidSlot;
  if (date && startTime) {
    const dayOfWeek = getDayOfWeek(date);
    const hours = await getOperatingHours(gymId, dayOfWeek);
    const validTimes = new Set(generateWindowedSlots(hours, gym.slotDuration).map(s => s.startTime));
    isValidSlot = validTimes.has(startTime);
  }

  return { ...gym, resolvedSlotPrice, ...(isValidSlot !== undefined ? { isValidSlot } : {}) };
}

export async function getSubscriptionPlans(gymId) {
  const gym = normalizeGymMoney(await prisma.gym.findUnique({ where: { id: gymId } }));
  if (!gym || !gym.isActive || !gym.isApproved) {
    throw { status: 404, error: 'Gym not found' };
  }

  const slots = await getSlotPrices(gymId);
  const priciestSlotPrice = slots.length > 0
    ? Math.max(...slots.map(s => s.price))
    : gym.sessionPrice;

  const plans = SUBSCRIPTION_PLANS
    .filter(p => gym[p.field] != null)
    .map(p => {
      const price = gym[p.field];
      const comparablePrice = Math.round(priciestSlotPrice * p.days * 100) / 100;
      // A partner-set plan price above the comparable per-slot cost would
      // otherwise show a negative "discount" — clamp to 0 instead of hiding
      // the plan, since it may still be a legitimate premium/convenience plan.
      const discountPercent = comparablePrice > 0
        ? Math.max(0, Math.round((1 - price / comparablePrice) * 100))
        : 0;
      return { planType: p.planType, days: p.days, price, comparablePrice, discountPercent };
    });

  return { gymId, priciestSlotPrice, plans };
}
