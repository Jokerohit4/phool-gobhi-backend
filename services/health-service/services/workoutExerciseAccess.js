export async function assertWorkoutExercisesVisible(prisma, userId, exerciseIds) {
  const ids = [...new Set(exerciseIds)];
  if (ids.length === 0) return;
  const visible = await prisma.exercise.findMany({
    where: { id: { in: ids }, OR: [{ createdByUserId: null }, { createdByUserId: userId }] },
    select: { id: true },
  });
  if (visible.length !== ids.length) {
    throw Object.assign(new Error('Exercise not found'), { status: 404 });
  }
}
