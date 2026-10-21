// Global exercise catalogue. Re-running only adds missing names; existing IDs,
// user exercises and curated content are preserved. No schema reset required.
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const exercises = JSON.parse(readFileSync(new URL('./exerciseCatalogue.json', import.meta.url), 'utf8'));
try {
  let created = 0;
  for (const { aliases, ...exercise } of exercises) {
    const existing = await prisma.exercise.findFirst({
      where: { name: { equals: exercise.name, mode: 'insensitive' }, createdByUserId: null },
    });
    if (existing) continue;
    await prisma.exercise.create({ data: exercise });
    created++;
  }
  console.log(`Exercise catalogue: ${exercises.length} definitions; ${created} added.`);
} finally {
  await prisma.$disconnect();
}
