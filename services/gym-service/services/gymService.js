import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary.js';
import { generateTimeSlots } from '../utils/slots.js';

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
  'sessionPrice', 'quotedPrice', 'weeklyPlanPrice', 'monthlyPlanPrice', 'quarterlyPlanPrice', 'yearlyPlanPrice',
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
  { planType: 'yearly', field: 'yearlyPlanPrice', days: 365 },
];

// Approval only vouches for the gym as it looked at review time — shared by
// updateGym (material fields) and upsertSlotPrices (per-slot pricing) so
// both call sites reset isApproved/rejectionReason the same way.
function maybeResetApproval(gym, updateData, changedMaterial) {
  if (gym.isApproved && changedMaterial) {
    updateData.isApproved = false;
  } else if (!gym.isApproved && gym.rejectionReason && Object.keys(updateData).length > 0) {
    updateData.rejectionReason = null;
  }
}

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
    established,
    brandDocs,
    openTime,
    closeTime,
    slotDuration,
    capacity,
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
      established: established ?? null,
      brandDocs: brandDocs || [],
      openTime,
      closeTime,
      slotDuration: finalSlotDuration,
      capacity: finalCapacity,
      isApproved: false,
      isActive: true,
    },
  });

  return normalizeGymMoney(gym);
}

export async function updateGym(gymId, partnerId, data) {
  // Normalized immediately — the MATERIAL_FIELDS comparison below does
  // `updateData[field] !== gym[field]`, and a raw Prisma Decimal is never
  // `===` to the plain number the request body sends, so every price-field
  // update would wrongly look "changed" (and reset isApproved) if this were
  // skipped, even when the value didn't actually move.
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
    'yearlyPlanPrice',
    // Lets a partner reactivate a gym that was deactivated via DELETE
    // /:id (softDeleteGym) — that route only ever sets isActive=false,
    // with no corresponding endpoint to flip it back until now.
    'isActive',
  ];

  allowedFields.forEach(field => {
    if (field in data) {
      updateData[field] = data[field];
    }
  });

  validateGymFields(updateData);

  // Approval only vouches for the gym as it looked at review time — if a
  // partner changes what's actually being reviewed (identity, location,
  // price) after approval, that approval no longer means anything and has
  // to be re-earned. Cosmetic fields (description, phone, hours, amenities,
  // capacity) don't trigger this.
  const MATERIAL_FIELDS = [
    'name', 'address', 'city', 'state', 'lat', 'lng', 'sessionPrice',
    'weeklyPlanPrice', 'monthlyPlanPrice', 'quarterlyPlanPrice', 'yearlyPlanPrice',
  ];
  const changedMaterialField = MATERIAL_FIELDS.some(
    field => field in updateData && updateData[field] !== gym[field]
  );
  maybeResetApproval(gym, updateData, changedMaterialField);

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

  const image = await prisma.gymImage.create({
    data: {
      gymId,
      url,
      publicId,
    },
  });

  return image;
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

  const image = await prisma.gymImage.findUnique({
    where: { id: imageId },
  });

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

  await prisma.gymImage.delete({
    where: { id: imageId },
  });

  return { message: 'Image deleted' };
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

export async function addGymDoc(gymId, partnerId, url) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  const updated = await prisma.gym.update({
    where: { id: gymId },
    data: { brandDocs: { push: url } },
    select: { brandDocs: true },
  });
  return updated.brandDocs;
}

export async function deleteGymDoc(gymId, partnerId, url) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  const remaining = (gym.brandDocs || []).filter((d) => d !== url);

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

export async function addReview(gymId, customerId, rating, comment) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
  });

  if (!gym || !gym.isActive || !gym.isApproved) {
    throw { status: 404, error: 'Gym not found' };
  }

  const review = await prisma.$transaction(async (tx) => {
    const created = await tx.gymReview.create({
      data: {
        gymId,
        customerId,
        rating,
        comment,
      },
    });

    const aggregate = await tx.gymReview.aggregate({
      where: { gymId },
      _avg: { rating: true },
      _count: true,
    });

    await tx.gym.update({
      where: { id: gymId },
      data: {
        rating: aggregate._avg.rating,
        ratingCount: aggregate._count,
      },
    });

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

    const aggregate = await tx.gymReview.aggregate({
      where: { gymId },
      _avg: { rating: true },
      _count: true,
    });

    await tx.gym.update({
      where: { id: gymId },
      data: {
        rating: aggregate._count > 0 ? aggregate._avg.rating : null,
        ratingCount: aggregate._count,
      },
    });
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

export async function createSlotBlock(gymId, partnerId, { date, startTime, endTime }) {
  const gym = await prisma.gym.findUnique({ where: { id: gymId } });
  if (!gym) throw { status: 404, error: 'Gym not found' };
  if (gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  // Prevent duplicate blocks
  const existing = await prisma.slotBlock.findFirst({
    where: { gymId, date, startTime },
  });
  if (existing) return existing;

  return prisma.slotBlock.create({
    data: { gymId, date, startTime, endTime },
  });
}

export async function deleteSlotBlock(blockId, partnerId) {
  const block = await prisma.slotBlock.findUnique({
    where: { id: blockId },
    include: { gym: { select: { partnerId: true } } },
  });
  if (!block) throw { status: 404, error: 'Block not found' };
  if (block.gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };

  await prisma.slotBlock.delete({ where: { id: blockId } });
  return { message: 'Block removed' };
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

  await prisma.$transaction(
    prices.map(p =>
      prisma.gymSlotPrice.upsert({
        where: { gymId_startTime: { gymId, startTime: p.startTime } },
        update: { price: p.price },
        create: { gymId, startTime: p.startTime, endTime: validSlots.get(p.startTime), price: p.price },
      })
    )
  );

  // Slot pricing is reviewed at approval time just like sessionPrice —
  // saving new prices on an already-approved gym re-earns that approval.
  const updateData = {};
  maybeResetApproval(gym, updateData, true);
  if (Object.keys(updateData).length > 0) {
    await prisma.gym.update({ where: { id: gymId }, data: updateData });
  }

  return getSlotPrices(gymId);
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
