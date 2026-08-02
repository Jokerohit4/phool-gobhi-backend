import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Attaches each review's customer name (and, for the admin view, phone) —
// PlatformReview only stores customerId, and this lives in the same DB/
// schema as User so it's a local join rather than a cross-service call.
async function withCustomerInfo(reviews, { includePhone = false } = {}) {
  if (reviews.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: reviews.map((r) => r.customerId) } },
    select: includePhone ? { id: true, name: true, phone: true } : { id: true, name: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return reviews.map((r) => ({
    ...r,
    customerName: byId.get(r.customerId)?.name || 'Phool Gobhi user',
    ...(includePhone ? { customerPhone: byId.get(r.customerId)?.phone || null } : {}),
  }));
}

export async function listApprovedPlatformReviews() {
  const reviews = await prisma.platformReview.findMany({
    where: { isApproved: true },
    orderBy: { createdAt: 'desc' },
  });
  return withCustomerInfo(reviews);
}

export async function listAllPlatformReviews() {
  const reviews = await prisma.platformReview.findMany({ orderBy: { createdAt: 'desc' } });
  return withCustomerInfo(reviews, { includePhone: true });
}

export async function upsertPlatformReview(customerId, { rating, comment }) {
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    throw { status: 400, error: 'rating must be an integer from 1 to 5' };
  }
  const trimmedComment = comment != null ? String(comment).trim().slice(0, 1000) || null : null;

  return prisma.platformReview.upsert({
    where: { customerId },
    create: { customerId, rating: numRating, comment: trimmedComment, isApproved: false },
    // Resubmitting resets isApproved — an edited review hasn't been vetted yet.
    update: { rating: numRating, comment: trimmedComment, isApproved: false },
  });
}

export async function setPlatformReviewApproval(id, isApproved) {
  try {
    return await prisma.platformReview.update({
      where: { id: Number(id) },
      data: { isApproved: !!isApproved },
    });
  } catch (err) {
    if (err.code === 'P2025') throw { status: 404, error: 'Review not found' };
    throw err;
  }
}

export async function deletePlatformReview(id) {
  try {
    await prisma.platformReview.delete({ where: { id: Number(id) } });
  } catch (err) {
    if (err.code === 'P2025') throw { status: 404, error: 'Review not found' };
    throw err;
  }
}
