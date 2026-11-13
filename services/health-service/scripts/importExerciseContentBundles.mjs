// Input is a reviewed package array with actual hosted assets, never a search URL.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { validateExerciseContentBundles, verifyExerciseBundleAssets } from '../utils/exerciseContentBundle.js';
if (!process.argv[2]) throw new Error('Usage: node scripts/importExerciseContentBundles.mjs <packages.json>');
const catalogue = JSON.parse(readFileSync(new URL('../prisma/exerciseCatalogue.json', import.meta.url), 'utf8'));
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// Validate the entire batch before a single production profile is written.
const bundles = validateExerciseContentBundles(input, catalogue);
await verifyExerciseBundleAssets(bundles);
const file = new URL('../prisma/ownedExerciseContent.json', import.meta.url);
const stored = JSON.parse(readFileSync(file, 'utf8'));
for (const bundle of bundles) stored[bundle.exerciseName] = bundle;
validateExerciseContentBundles(Object.values(stored), catalogue);
if (process.argv.includes('--check')) {
  console.log(`Validated ${bundles.length} complete packages and all hosted media. No files changed.`);
  process.exit(0);
}
const temporary = new URL('../prisma/ownedExerciseContent.json.tmp', import.meta.url);
writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n');
renameSync(temporary, file);
console.log(`Imported ${bundles.length} complete content packages; ${Object.keys(stored).length} total. No database writes.`);
