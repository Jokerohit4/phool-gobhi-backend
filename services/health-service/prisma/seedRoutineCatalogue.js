// Seeds the routine catalogue (system WorkoutTemplates) from
// prisma/catalogue/routines.json. Run after the exercise library is seeded:
//   node prisma/seed.js && node prisma/seedRoutineCatalogue.js
// (the deploy workflow runs it through `npm run seed:routines`).
//
// This replaces seedBeginnerTemplates.js and seedHomeTrack.js: their 16
// routines are rows 1-16 of the data file, matched by the keys the
// 20261128000000_routine_catalogue migration backfilled. Idempotent and
// create-only; see services/routines/catalogueSeed.js.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { seedRoutineCatalogue } from '../services/routines/catalogueSeed.js';

export const catalogueData = () => JSON.parse(
  readFileSync(new URL('./catalogue/routines.json', import.meta.url), 'utf8'),
).routines;

async function main() {
  const prisma = new PrismaClient();
  try {
    const out = await seedRoutineCatalogue(prisma, catalogueData());
    console.log(
      `Routine catalogue: ${out.created} created, ${out.textsAdded} translations added, ` +
      `${out.total - out.created - out.skipped.length} already present` +
      (out.skipped.length ? `, ${out.skipped.length} skipped (name already used: ${out.skipped.join(', ')})` : '') + '.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
