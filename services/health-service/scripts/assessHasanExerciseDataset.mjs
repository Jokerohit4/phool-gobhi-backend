// Assess a locally supplied source file without publishing or changing the DB.
// node services/health-service/scripts/assessHasanExerciseDataset.mjs <exercises.json>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHasanDataset, proposeHasanMatches, HASAN_LANGUAGES } from '../utils/hasanExerciseDataset.js';

const service = fileURLToPath(new URL('../', import.meta.url));
const input = process.argv[2] ?? join(service, 'prisma/sources/hasaneyldrm-exercises-dataset.json');
if (!existsSync(input)) {
  console.error(`Source file is missing: ${input}\nSave https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/data/exercises.json locally, then rerun with that file path.`);
  process.exitCode = 1;
} else {
  const bytes = readFileSync(input);
  const source = validateHasanDataset(JSON.parse(bytes.toString('utf8')));
  const read = (name) => JSON.parse(readFileSync(join(service, 'prisma', name), 'utf8'));
  const rows = proposeHasanMatches(read('exerciseCatalogue.json'), source, read('exerciseMedia.json'));
  const output = fileURLToPath(new URL('../../../docs/exercise-data-gaps/hasaneyldrm/', import.meta.url));
  mkdirSync(output, { recursive: true });
  const csv = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  for (const status of ['unmatched', 'ambiguous', 'candidate_requires_movement_review']) {
    const flat = rows.filter((row) => row.status === status).flatMap((row) =>
      (row.candidates.length ? row.candidates : [{}]).map((candidate) => ({ ...row, ...candidate })));
    const columns = ['name', 'muscleGroup', 'equipment', 'status', 'sourceId', 'sourceName', 'method', 'sourceEquipment', 'target', 'bodyPart'];
    writeFileSync(join(output, `${status}.csv`), [columns.map(csv).join(','), ...flat.map((row) => columns.map((key) => csv(row[key])).join(','))].join('\n') + '\n');
  }
  const summary = {
    source: 'https://github.com/hasaneyldrm/exercises-dataset',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceRecords: source.length, catalogueExercises: rows.length,
    unambiguousCandidates: rows.filter((row) => row.status === 'candidate_requires_movement_review').length,
    ambiguous: rows.filter((row) => row.status === 'ambiguous').length,
    unmatched: rows.filter((row) => row.status === 'unmatched').length,
    sourceMissingInstructions: Object.fromEntries(HASAN_LANGUAGES.map((lang) => [lang,
      source.filter((entry) => !entry.instruction_steps[lang].length && !entry.instructions[lang].trim()).length])),
    notProvidedBySource: ['tutorial videos', 'difficulty', 'force', 'movement mechanic'],
    scope: 'Matching proposals; not verified assets or published mappings. No database changes.',
  };
  writeFileSync(join(output, 'assessment.json'), JSON.stringify({ ...summary, exercises: rows }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
