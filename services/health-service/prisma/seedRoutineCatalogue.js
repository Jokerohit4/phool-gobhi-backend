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
      (out.skipped.length ? `, ${out.skipped.length} skipped` : '') + '.',
    );
    if (out.skipped.length > 0) {
      // A skip means a system routine already uses this name but has no key, so
      // the migration's by-name backfill did not match it (renamed by hand?).
      // Plans look routines up by key, so staying quiet would silently drop it.
      console.error(
        `ERROR: not created because a system routine with that name already exists without a key: ` +
        `${out.skipped.join(', ')}. Set its key in the database (see the routine_catalogue migration) and re-run.`,
      );
      process.exitCode = 1;
    }
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
