// Turns the actual gap inventory into executable content-production batches.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const catalogue = read('services/health-service/prisma/exerciseCatalogue.json');
const summary = read('docs/exercise-data-gaps/summary.json');
const source = readFileSync(join(root, '../phool-gobhi-customer-app/lib/data/workout/starter_templates.dart'), 'utf8');
const uses = new Map();
for (const match of source.matchAll(/StarterExerciseSeed\(\s*'([^']+)'/g)) uses.set(match[1], (uses.get(match[1]) ?? 0) + 1);
if (!uses.size) throw new Error('Starter-routine names could not be extracted');
const gapNames = new Map(summary.lists.map((list) => {
  const text = readFileSync(join(root, 'docs/exercise-data-gaps', list.file), 'utf8');
  return [list.id, new Set(text.trimEnd().split('\n').slice(1).map((line) => /^"((?:[^"]|"")*)"/.exec(line)?.[1].replaceAll('""', '"')))];
}));
const missing = (name, id) => gapNames.get(id)?.has(name) ?? false;
const tasks = catalogue.map((exercise) => {
  const informational = new Set(['missing-direct-demo-video', 'missing-source-photo-gallery', 'missing-source-category', 'missing-source-equipment',
    'missing-all-instruction-text', 'missing-both-gif-and-photos', 'missing-all-visual-media', 'missing-visual-and-instructions', 'missing-watchable-video']);
  const gaps = summary.lists.filter((list) => !informational.has(list.id)
    && (list.id !== 'missing-secondary-muscles' || missing(exercise.name, 'unreviewed-secondary-muscles'))
    && missing(exercise.name, list.id)).map((list) => list.id);
  const visual = missing(exercise.name, 'missing-photos') && missing(exercise.name, 'missing-demo-gif') && missing(exercise.name, 'missing-direct-demo-video');
  const guide = missing(exercise.name, 'missing-source-instructions');
  const starterUses = uses.get(exercise.name) ?? 0;
  const priority = (visual || guide) && starterUses ? 'P0' : visual || guide ? 'P1'
    : starterUses ? 'P2' : 'P3';
  const deliverables = [];
  if (visual || missing(exercise.name, 'missing-demo-gif')) deliverables.push('exact-movement-demo.mp4', 'derived-demo.gif', 'derived-thumbnail.jpg');
  if (missing(exercise.name, 'missing-tutorial-video')) deliverables.push('instructional-form-guide.mp4');
  if (guide || missing(exercise.name, 'missing-hindi-source-instructions')) deliverables.push('english-and-hindi-steps.json');
  if (gaps.some((gap) => ['missing-source-difficulty', 'missing-source-force', 'missing-source-mechanic', 'missing-secondary-muscles'].includes(gap))) deliverables.push('trainer-classification-review.json');
  return { name: exercise.name, equipment: exercise.equipment, muscleGroup: exercise.muscleGroup,
    priority, starterUses, missingVisual: visual, missingGuide: guide, gaps, deliverables,
    requiredReview: 'Match equipment, grip, angle, laterality, range and tempo. A demonstration without teaching does not fulfil a tutorial task.' };
}).filter((task) => task.gaps.length).sort((a, b) => a.priority.localeCompare(b.priority) || b.starterUses - a.starterUses || a.name.localeCompare(b.name));
const output = join(root, 'docs/exercise-content-production');
mkdirSync(output, { recursive: true });
const csv = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const columns = ['name', 'equipment', 'muscleGroup', 'priority', 'starterUses', 'missingVisual', 'missingGuide', 'deliverables'];
for (const priority of ['P0', 'P1', 'P2', 'P3']) {
  const rows = tasks.filter((task) => task.priority === priority);
  writeFileSync(join(output, `${priority}.csv`), [columns.map(csv).join(','), ...rows.map((row) => columns.map((column) => csv(Array.isArray(row[column]) ? row[column].join('; ') : row[column])).join(','))].join('\n') + '\n');
}
const counts = Object.fromEntries(['P0', 'P1', 'P2', 'P3'].map((priority) => [priority, tasks.filter((task) => task.priority === priority).length]));
writeFileSync(join(output, 'recording-plan.json'), JSON.stringify({ catalogueExercises: catalogue.length, priorities: counts, tasks }, null, 2) + '\n');
const first = tasks[0];
writeFileSync(join(output, 'content-package.template.json'), JSON.stringify([{
  exerciseName: first.name, equipment: first.equipment, reviewStatus: 'pending', reviewedBy: null, reviewedAt: null,
  rights: null, rightsEvidence: null, attribution: null,
  imageUrl: null, demoGifUrl: null, demoVideoUrl: null, tutorialVideoUrl: null,
  hasInstructionalExplanation: false, tutorialLanguage: null, tutorialDurationSeconds: null, videoCodec: null,
  instructions: { en: [], hi: [] }, secondaryMuscles: [], emptySecondaryMusclesReason: null,
  classification: { difficulty: { value: null, basis: null }, force: { value: null, basis: null }, mechanic: { value: null, basis: null } },
}], null, 2) + '\n');
console.log(JSON.stringify({ priorities: counts, totalTasks: tasks.length, starterExercises: uses.size, firstExercise: first.name }, null, 2));
