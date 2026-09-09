import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// DPDPA access right (s.11) for the one thing gym-service holds about a
// customer: the reviews they wrote. Called by auth-service's platform-wide
// export.
//
// Reviews are user-authored public content, which puts them in an awkward
// spot: they are unmistakably the reviewer's personal data, and they are also
// the thing other customers rely on when choosing a gym. Nothing here decides
// what happens to them on account deletion (they are not currently erased);
// this only makes sure the person can see what they wrote and what ratings
// are attached to their name.
export async function buildExportService(userId) {
  const reviews = await prisma.gymReview.findMany({
    where: { customerId: userId },
    include: { gym: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return {
    reviews: reviews.map((r) => ({
      at: r.createdAt,
      gymId: r.gym?.id ?? r.gymId,
      gymName: r.gym?.name ?? null,
      rating: r.rating,
      comment: r.comment,
      breakdown: {
        equipment: r.equipmentRating,
        cleanliness: r.cleanlinessRating,
        trainer: r.trainerRating,
        valueForMoney: r.valueForMoneyRating,
        staffBehaviour: r.staffBehaviourRating,
        crowd: r.crowdRating,
      },
    })),
  };
}
