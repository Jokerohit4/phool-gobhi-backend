import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary.js';
import { generateTimeSlots } from '../utils/slots.js';
import * as placesService from './placesService.js';

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
  'commissionPct',
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

export async function listGyms({ city, minPrice, maxPrice, search, amenities, userLat, userLng }) {
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
    include: { images: true },
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
    gyms.sort((a, b) => a.distanceKm - b.distanceKm);
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
    include: { images: true },
    orderBy: { createdAt: 'desc' },
  });
  return gyms.map(normalizeGymMoney);
}

export async function getGymById(id, userLat, userLng) {
  const gym = normalizeGymMoney(await prisma.gym.findUnique({
    where: { id },
    include: { images: true, reviews: true },
  }));

  if (!gym || !gym.isActive || !gym.isApproved) {
    throw { status: 404, error: 'Gym not found' };
  }

  if (userLat != null && userLng != null && gym.lat != null && gym.lng != null) {
    return {
      ...gym,
      distanceKm: Math.round(haversineKm(userLat, userLng, gym.lat, gym.lng) * 10) / 10,
    };
  }

  return gym;
}


export async function getGymByIdRaw(id) {
  const gym = await prisma.gym.findUnique({
    where: { id },
    include: { images: true },
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

  // Changing hours/duration shifts slot boundaries, which can orphan
  // GymSlotPrice rows whose startTime no longer appears in the regenerated
  // slot list — clear those out so stale prices don't silently linger.
  if ('openTime' in updateData || 'closeTime' in updateData || 'slotDuration' in updateData) {
    const validStartTimes = generateTimeSlots(updated.openTime, updated.closeTime, updated.slotDuration)
      .map(s => s.startTime);
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
  ];

  allowedFields.forEach(field => {
    if (field in data) {
      updateData[field] = data[field];
    }
  });

  validateGymFields(updateData);

  const { isActive, ...gatedData } = updateData;

  let updatedGym = gym;
  if (isActive !== undefined) {
    updatedGym = normalizeGymMoney(await prisma.gym.update({
      where: { id: gymId },
      data: { isActive },
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

export async function getPartnerGyms(partnerId) {
  const gyms = await prisma.gym.findMany({
    where: { partnerId },
    include: { images: true },
  });

  return gyms.map(normalizeGymMoney);
}

// Compact onboarding summary for a partner — does an active gym exist yet, and
// is it approved. Used by auth-service to tell the partner app, at login, where
// to route (dashboard vs. resume onboarding) without trusting local state.
export async function getPartnerGymSummary(partnerId) {
  const gyms = await prisma.gym.findMany({
    where: { partnerId, isActive: true },
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
async function applyGymImageAdd(gymId, { url, publicId }) {
  return prisma.gymImage.create({ data: { gymId, url, publicId } });
}

async function applyGymImageDelete({ imageId }) {
  const image = await prisma.gymImage.findUnique({ where: { id: imageId } });
  if (!image) {
    throw { status: 404, error: 'Image not found' };
  }

  if (image.publicId) {
    try {
      await cloudinary.uploader.destroy(image.publicId);
    } catch (err) {
      console.error('Error deleting image from Cloudinary:', err.message);
    }
  }

  await prisma.gymImage.delete({ where: { id: imageId } });
  return { message: 'Image deleted' };
}

export async function addGymImage(gymId, partnerId, url, publicId) {
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
    const editRequest = await createEditRequest(gymId, partnerId, 'image_add', { url, publicId });
    return { pending: true, editRequest };
  }

  return applyGymImageAdd(gymId, { url, publicId });
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

// Pending edit requests ------------------------------------------------------
// Once a gym is approved, the gated mutations above (updateGym's non-isActive
// fields, image/doc add-delete, slot prices, slot blocks) route here instead
// of writing live. A gobhi reviews the payload and either approves it (which
// dispatches to the same apply* function the mutation would have called
// directly on an unapproved gym) or rejects it (no live write at all).

async function createEditRequest(gymId, partnerId, changeType, payload) {
  // A partner is never blocked from resubmitting — the newest request for a
  // given (gym, changeType) simply supersedes whatever was still pending,
  // so duplicate pending rows never pile up and there's always exactly one
  // pending request per changeType to review.
  await prisma.gymEditRequest.updateMany({
    where: { gymId, changeType, status: 'pending' },
    data: { status: 'rejected', rejectionReason: 'Superseded by a newer request' },
  });

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
    include: { gym: true },
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
    default:
      throw { status: 500, error: `Unknown edit request type: ${request.changeType}` };
  }

  return prisma.gymEditRequest.update({
    where: { id },
    data: { status: 'approved', reviewedBy: gobhiId, reviewedAt: new Date() },
  });
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

  return prisma.gymEditRequest.update({
    where: { id },
    data: { status: 'rejected', rejectionReason: reason, reviewedBy: gobhiId, reviewedAt: new Date() },
  });
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

  const slots = generateTimeSlots(gym.openTime, gym.closeTime, gym.slotDuration);
  const priceMap = await getSlotPriceMap(gymId);

  return slots.map(s => ({
    startTime: s.startTime,
    endTime: s.endTime,
    price: priceMap.has(s.startTime) ? priceMap.get(s.startTime) : gym.sessionPrice,
    isDefault: !priceMap.has(s.startTime),
  }));
}

// Re-derives valid slots from the gym as it looks RIGHT NOW rather than
// trusting whatever was valid when the request was submitted — hours/duration
// may have changed (via a separately-approved profile edit) in the meantime.
async function applySlotPrices(gymId, prices) {
  const gym = normalizeGymMoney(await prisma.gym.findUnique({ where: { id: gymId } }));
  const validSlots = new Map(
    generateTimeSlots(gym.openTime, gym.closeTime, gym.slotDuration).map(s => [s.startTime, s.endTime])
  );

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
  const gym = normalizeGymMoney(await prisma.gym.findUnique({ where: { id: gymId } }));
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  if (!Array.isArray(prices) || prices.length === 0) {
    throw { status: 400, error: 'prices must be a non-empty array of {startTime, price}' };
  }

  const validSlots = new Map(
    generateTimeSlots(gym.openTime, gym.closeTime, gym.slotDuration).map(s => [s.startTime, s.endTime])
  );

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
// consumed by booking-service via GET /internal/:id?startTime=.
export async function getGymInternalWithSlotPrice(gymId, startTime) {
  const gym = await getGymByIdRaw(gymId);

  let resolvedSlotPrice = gym.sessionPrice;
  if (startTime) {
    const row = await prisma.gymSlotPrice.findUnique({
      where: { gymId_startTime: { gymId, startTime } },
    });
    resolvedSlotPrice = row ? Number(row.price) : gym.sessionPrice;
  }

  return { ...gym, resolvedSlotPrice };
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
