// Reproducible, additive content supplement. Does not change exercise IDs or DB.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateHasanDataset, proposeHasanMatches } from '../utils/hasanExerciseDataset.js';
const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
const source = validateHasanDataset(read('sources/hasaneyldrm-exercises-dataset.json'));
const catalogue = read('exerciseCatalogue.json');
const provenance = read('sources/hasaneyldrm-provenance.json');
const bytes = readFileSync(new URL('../prisma/sources/hasaneyldrm-exercises-dataset.json', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== provenance.sha256) throw new Error('Source checksum differs from verified revision');
const reviewed = read('sources/hasaneyldrm-reviewed-mappings.json');
const byId = new Map(source.map((entry) => [entry.id, entry]));
const proposals = proposeHasanMatches(catalogue, source, read('exerciseMedia.json'));
const base = `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${provenance.revision}/`;
const supplements = {};
const decisions = [];
for (const row of proposals) {
  const manual = reviewed.selected[row.name];
  const candidate = manual ? { sourceId: manual.id, method: 'reviewed_equivalence' }
    : row.status === 'candidate_requires_movement_review' ? row.candidates[0] : null;
  if (reviewed.excluded[row.name] || !candidate) {
    decisions.push({ name: row.name, status: reviewed.excluded[row.name] ? 'excluded_variant' : row.status,
      reason: reviewed.excluded[row.name] ?? null });
    continue;
  }
  const entry = byId.get(candidate.sourceId);
  if (!entry) throw new Error(`Missing reviewed source id for ${row.name}`);
  supplements[row.name] = {
    equipment: row.equipment,
    sourceId: entry.id, sourceName: entry.name, sourceEquipment: entry.equipment,
    bodyPart: entry.body_part, category: entry.category, target: entry.target,
    secondaryMuscles: entry.secondary_muscles,
    instructionsByLanguage: manual?.useInstructions === false
      ? Object.fromEntries(Object.keys(entry.instruction_steps).map((lang) => [lang, []])) : entry.instruction_steps,
    imageUrl: base + entry.image, gifUrl: base + entry.gif_url,
    mediaAttribution: entry.attribution,
    instructionAttribution: 'hasaneyldrm/exercises-dataset (MIT)',
    sourceUrl: `https://github.com/hasaneyldrm/exercises-dataset/blob/${provenance.revision}/data/exercises.json`,
  };
  decisions.push({ name: row.name, status: 'integrated', sourceId: entry.id, sourceName: entry.name,
    method: candidate.method, reason: manual?.reason ?? 'Compatible equipment with existing media identity or equivalent explicit movement words.' });
}
for (const name of Object.keys(reviewed.selected)) if (!supplements[name]) throw new Error(`Reviewed mapping not used: ${name}`);
writeFileSync(new URL('../prisma/exerciseSupplements.json', import.meta.url), JSON.stringify(supplements, null, 2) + '\n');
const report = { sourceRevision: provenance.revision, sourceRecords: source.length, catalogueExercises: catalogue.length,
  integrated: Object.keys(supplements).length, unresolved: catalogue.length - Object.keys(supplements).length, decisions };
writeFileSync(new URL('../prisma/sources/hasaneyldrm-integration-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
const output = new URL('../../../docs/exercise-data-gaps/hasaneyldrm/', import.meta.url);
mkdirSync(output, { recursive: true });
const csv = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
for (const [file, rows] of [['integrated.csv', decisions.filter((row) => row.status === 'integrated')],
  ['unresolved-after-integration.csv', decisions.filter((row) => row.status !== 'integrated')]]) {
  const columns = ['name', 'status', 'sourceId', 'sourceName', 'method', 'reason'];
  writeFileSync(new URL(file, output), [columns.map(csv).join(','), ...rows.map((row) => columns.map((key) => csv(row[key])).join(','))].join('\n') + '\n');
}
console.log(JSON.stringify({ sourceRecords: report.sourceRecords, integrated: report.integrated, unresolved: report.unresolved }, null, 2));
