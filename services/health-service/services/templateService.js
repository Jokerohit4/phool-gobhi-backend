import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const includeExercises = {
  exercises: { include: { exercise: true }, orderBy: { order: 'asc' } },
};

// "Last done" (shown on the Routines/Workouts home screen) is the most
// recent session actually started from this template — computed here
// rather than denormalized onto WorkoutTemplate, since it's cheap (one
// indexed query) and can never go stale.
async function attachLastDone(templates) {
  return Promise.all(
    templates.map(async (t) => {
      const lastSession = await prisma.workoutSession.findFirst({
        where: { templateId: t.id },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      });
      return { ...t, lastDoneAt: lastSession?.startedAt || null };
    }),
  );
}

export async function listTemplatesService(userId) {
  const templates = await prisma.workoutTemplate.findMany({
    where: { userId },
    include: includeExercises,
    orderBy: { updatedAt: 'desc' },
  });
  return attachLastDone(templates);
}

export async function createTemplateService(userId, body) {
  const { name, exercises } = body || {};
  if (!name || !Array.isArray(exercises) || exercises.length === 0) {
    const err = new Error('name and a non-empty exercises array are required');
    err.status = 400;
    throw err;
  }
  for (const ex of exercises) {
    if (!ex.exerciseId || !ex.targetSets || !ex.targetReps) {
      const err = new Error('each exercise needs exerciseId, targetSets and targetReps');
      err.status = 400;
      throw err;
    }
  }
  return prisma.workoutTemplate.create({
    data: {
      userId,
      name,
      exercises: {
        create: exercises.map((ex, i) => ({
          exerciseId: ex.exerciseId,
          order: i,
          targetSets: ex.targetSets,
          targetReps: ex.targetReps,
          restSeconds: ex.restSeconds ?? null,
          supersetGroup: ex.supersetGroup ?? null,
        })),
      },
    },
    include: includeExercises,
  });
}

async function assertOwnsTemplate(templateId, userId) {
  const template = await prisma.workoutTemplate.findUnique({ where: { id: templateId } });
  if (!template || template.userId !== userId) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  return template;
}

// Replace-all semantics for the exercise list — the Create/Edit Routine
// screen always submits the full, reordered list (drag-to-reorder, add,
// remove all happen client-side first), so deleting and recreating the
// TemplateExercise rows is simpler and less error-prone than diffing.
export async function updateTemplateService(templateId, userId, body) {
  await assertOwnsTemplate(templateId, userId);
  const { name, exercises } = body || {};
  return prisma.$transaction(async (tx) => {
    if (Array.isArray(exercises)) {
      await tx.templateExercise.deleteMany({ where: { templateId } });
      await tx.templateExercise.createMany({
        data: exercises.map((ex, i) => ({
          templateId,
          exerciseId: ex.exerciseId,
          order: i,
          targetSets: ex.targetSets,
          targetReps: ex.targetReps,
          restSeconds: ex.restSeconds ?? null,
          supersetGroup: ex.supersetGroup ?? null,
        })),
      });
    }
    return tx.workoutTemplate.update({
      where: { id: templateId },
      data: { ...(name ? { name } : {}) },
      include: includeExercises,
    });
  });
}

export async function deleteTemplateService(templateId, userId) {
  await assertOwnsTemplate(templateId, userId);
  // Past sessions keep their own SessionExercise/WorkoutSet rows regardless
  // (they don't cascade off the template) — only WorkoutSession.templateId
  // is nulled by the FK, per Prisma's default behavior for an unspecified
  // onDelete on that relation, so history is never silently deleted by
  // deleting the routine it was started from.
  await prisma.workoutTemplate.delete({ where: { id: templateId } });
}
