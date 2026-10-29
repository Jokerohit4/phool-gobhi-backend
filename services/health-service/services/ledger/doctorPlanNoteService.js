// User-authored records. Only confirmed structured targets affect scoring;
// free text is never interpreted or converted into tasks.
import { validateDoctorPlan } from './doctorPlan.js';
export async function saveDoctorPlanNote({ prisma, storage, userId, description = '', plan }) {
  const structuredPlan = plan == null ? null : validateDoctorPlan(plan);
  if (typeof description !== 'string' || (!description.trim() && !structuredPlan) || description.length > 4000) {
    throw Object.assign(new Error('Describe your doctor\'s plan in 1 to 4000 characters.'), { status: 400 });
  }
  const notes = description.trim();
  const buffer = Buffer.from(structuredPlan ? JSON.stringify({ plan: structuredPlan, notes }, null, 2) : notes, 'utf8');
  const storagePath = await storage.savePlanNote({ buffer, userId });
  try {
    const data = {
      userId, storagePath, kind: 'prescription', title: "My doctor's plan",
      notes, ...(structuredPlan ? { structuredPlan } : {}), mimeType: 'text/plain', sizeBytes: buffer.length,
    };
    const doc = structuredPlan ? await prisma.$transaction(async tx => {
      // Serialise plan replacement for this account; two simultaneous saves
      // cannot leave two plans active.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${userId}::bigint)`;
      await tx.medicalDocument.updateMany({ where: { userId, structuredPlan: { path: ['version'], equals: 1 }, supersededAt: null },
        data: { supersededAt: new Date() } });
      return tx.medicalDocument.create({ data });
    }) : await prisma.medicalDocument.create({ data });
    const { storagePath: omitted, ...safe } = doc;
    return safe;
  } catch {
    // A failed row write must not leave an unlisted private record behind.
    await storage.deleteObjects([storagePath]).catch(() => {});
    // Prisma validation errors can include write arguments. Do not let those
    // reach the controller logger with private instructions embedded in them.
    throw new Error('Could not save your plan description. Please try again.');
  }
}
