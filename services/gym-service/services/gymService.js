import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary.js';

const prisma = new PrismaClient();

export async function listGyms({ city, minPrice, maxPrice, search, amenities }) {
  const where = {
    isActive: true,
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

  let gyms = await prisma.gym.findMany({
    where,
    include: { images: true },
  });

  if (amenities) {
    const amenitiesArray = amenities.split(',').map(a => a.trim());
    gyms = gyms.filter(gym =>
      amenitiesArray.every(amenity => gym.amenities.includes(amenity))
    );
  }

  return gyms;
}

export async function getGymById(id) {
  const gym = await prisma.gym.findUnique({
    where: { id },
    include: { images: true, reviews: true },
  });

  if (!gym || !gym.isActive) {
    throw { status: 404, error: 'Gym not found' };
  }

  return gym;
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
    openTime,
    closeTime,
    slotDuration,
    capacity,
  } = data;

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
      openTime,
      closeTime,
      slotDuration: slotDuration || 60,
      capacity: capacity || 20,
      isApproved: false,
      isActive: true,
    },
  });

  return gym;
}

export async function updateGym(gymId, partnerId, data) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
  });

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
    'openTime',
    'closeTime',
    'slotDuration',
    'capacity',
  ];

  allowedFields.forEach(field => {
    if (field in data) {
      updateData[field] = data[field];
    }
  });

  const updated = await prisma.gym.update({
    where: { id: gymId },
    data: updateData,
  });

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

  return deleted;
}

export async function getPartnerGyms(partnerId) {
  const gyms = await prisma.gym.findMany({
    where: { partnerId },
    include: { images: true },
  });

  return gyms;
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

export async function addReview(gymId, customerId, rating, comment) {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
  });

  if (!gym) {
    throw { status: 404, error: 'Gym not found' };
  }

  const review = await prisma.gymReview.create({
    data: {
      gymId,
      customerId,
      rating,
      comment,
    },
  });

  const allReviews = await prisma.gymReview.findMany({
    where: { gymId },
  });

  const totalRating = allReviews.reduce((sum, r) => sum + r.rating, 0);
  const avgRating = totalRating / allReviews.length;

  await prisma.gym.update({
    where: { id: gymId },
    data: {
      rating: avgRating,
      ratingCount: allReviews.length,
    },
  });

  return review;
}

export async function getGymReviews(gymId) {
  const reviews = await prisma.gymReview.findMany({
    where: { gymId },
    orderBy: { createdAt: 'desc' },
  });

  return reviews;
}
