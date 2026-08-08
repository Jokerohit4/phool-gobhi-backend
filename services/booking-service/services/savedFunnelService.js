import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// steps shape: [{ event: string, filters?: Record<string,string> }, ...], in
// the order they're required to occur. Validated here (not just trusted from
// the client) because analyticsQueryService.getCustomFunnel builds raw SQL
// fragments from event/filter keys — this is the one gate standing between
// admin input and that query, so it rejects anything that isn't a plain
// string/string-map shape before it ever reaches the DB layer.
function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 8) {
    throw new Error('A funnel needs between 2 and 8 steps');
  }
  return steps.map((step, i) => {
    const event = typeof step?.event === 'string' ? step.event.trim() : '';
    if (!event) throw new Error(`Step ${i + 1} is missing an event name`);
    const filters = {};
    for (const [key, value] of Object.entries(step.filters || {})) {
      if (typeof key !== 'string' || !key.trim()) continue;
      if (typeof value !== 'string' || !value.trim()) continue;
      filters[key.trim()] = value.trim();
    }
    return { event, filters };
  });
}

export async function listSavedFunnels() {
  return prisma.savedFunnel.findMany({ orderBy: { updatedAt: 'desc' } });
}

export async function getSavedFunnel(id) {
  return prisma.savedFunnel.findUnique({ where: { id: Number(id) } });
}

export async function createSavedFunnel(name, steps, createdBy) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('Name is required');
  const validSteps = validateSteps(steps);
  return prisma.savedFunnel.create({
    data: { name: trimmedName, steps: validSteps, createdBy: createdBy ?? null },
  });
}

export async function deleteSavedFunnel(id) {
  await prisma.savedFunnel.delete({ where: { id: Number(id) } });
}

export { validateSteps };
