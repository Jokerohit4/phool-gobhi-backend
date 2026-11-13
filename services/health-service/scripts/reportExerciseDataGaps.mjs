// Offline inventory of retained source fields and content prepared for the app.
// Run from the backend root: node services/health-service/scripts/reportExerciseDataGaps.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isExerciseMediaUrl } from '../utils/exerciseMedia.js';
import { withExerciseSource } from '../services/exerciseSourceService.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, 'docs/exercise-data-gaps');
const read = (file) => JSON.parse(readFileSync(new URL(`../prisma/${file}`, import.meta.url), 'utf8'));
const catalogue = read('exerciseCatalogue.json');
const media = read('exerciseMedia.json');
const sources = read('exerciseSources.json');
const snapshot = read('sources/free-exercise-db.json');
const hasanProvenance = read('sources/hasaneyldrm-provenance.json');
const wgerProvenance = read('sources/wger-provenance.json');
const videos = read('exerciseVideos.json');
const sourceById = new Map(snapshot.map((entry) => [entry.id, entry]));
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const hasList = (value) => Array.isArray(value) && value.some(hasText);
const csv = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const saveCsv = (file, columns, rows) => writeFileSync(join(output, file),
  [columns.map(csv).join(','), ...rows.map((row) => columns.map((column) => csv(row[column])).join(','))].join('\n') + '\n');
mkdirSync(output, { recursive: true });

const rows = catalogue.map((exercise) => {
  const seed = media[exercise.name];
  const mapped = sources[exercise.name];
  // Match the API's equipment guard; an incompatible name is not coverage.
  const source = mapped?.equipment === exercise.equipment ? mapped : undefined;
  const original = sourceById.get(source?.sourceId);
  const effective = withExerciseSource({ ...exercise, demoGifUrl: seed?.gifUrl, demoImageUrl: seed?.imageUrl }, 'en');
  const supplement = effective.sourceMetadata?.hasaneyldrm;
  const reference = effective.sourceMetadata?.references;
  const owned = effective.sourceMetadata?.owned;
  return {
    name: exercise.name, muscle_group: exercise.muscleGroup, equipment: exercise.equipment,
    logging_type: exercise.loggingType,
    has_demo_gif: isExerciseMediaUrl(effective.demoGifUrl),
    has_photo: isExerciseMediaUrl(effective.demoImageUrl) || hasList(effective.sourceImageUrls),
    has_source_photos: hasList(effective.sourceImageUrls),
    has_tutorial: videos.some((video) => video.exercise === exercise.name && hasText(video.youtubeVideoId))
      || (effective.formVideos?.some((video) => video.kind === 'tutorial' && isExerciseMediaUrl(video.videoUrl)) ?? false),
    has_demo_video: effective.demoVideos?.some((video) => isExerciseMediaUrl(video.videoUrl)) ?? false,
    has_source_instructions: hasList(effective.sourceInstructions),
    has_hindi_source_instructions: withExerciseSource({ ...exercise }, 'hi').sourceInstructionLanguage === 'hi',
    has_seed_english_instructions: hasList(seed?.steps?.en),
    has_primary_muscles: hasList(effective.primaryMuscles),
    has_secondary_muscles: hasList(effective.secondaryMuscles),
    secondary_review_status: hasList(effective.secondaryMuscles) ? 'listed' : owned?.emptySecondaryMusclesReason ? 'reviewed_empty' : 'unreviewed',
    source_id: source?.sourceId ?? (supplement ? `hasaneyldrm:${supplement.sourceId}` : reference?.providers.map((row) => `${row.provider}:${row.sourceId}`).join(';') ?? ''),
    source_difficulty: owned?.classification.difficulty.value ?? original?.level ?? reference?.classification.difficulty ?? '',
    source_force: owned?.classification.force.value ?? original?.force ?? reference?.classification.force ?? '',
    source_mechanic: owned?.classification.mechanic.value ?? original?.mechanic ?? reference?.classification.mechanic ?? '',
    source_category: original?.category ?? supplement?.category ?? reference?.classification.category ?? '',
    source_equipment: original?.equipment ?? supplement?.equipment ?? reference?.classification.equipment ?? '',
  };
}).sort((a, b) => a.name.localeCompare(b.name, 'en'));

const lists = [
  { id: 'missing-demo-gif', label: 'No usable demo GIF URL', group: 'Content', missing: (r) => !r.has_demo_gif },
  { id: 'missing-photos', label: 'No photo URL from either media seed or source', group: 'Content', missing: (r) => !r.has_photo },
  { id: 'missing-source-photo-gallery', label: 'No source photo gallery', group: 'Content', missing: (r) => !r.has_source_photos },
  { id: 'missing-tutorial-video', label: 'No tutorial video seed entry', group: 'Content', missing: (r) => !r.has_tutorial },
  { id: 'missing-direct-demo-video', label: 'No licensed direct MP4 demonstration', group: 'Content', missing: (r) => !r.has_demo_video },
  { id: 'missing-watchable-video', label: 'No tutorial entry or direct demonstration', group: 'Content', missing: (r) => !r.has_tutorial && !r.has_demo_video },
  { id: 'missing-source-instructions', label: 'No source fallback instructions', group: 'Content', missing: (r) => !r.has_source_instructions },
  { id: 'missing-hindi-source-instructions', label: 'No Hindi source fallback instructions', group: 'Content', missing: (r) => !r.has_hindi_source_instructions },
  { id: 'missing-all-instruction-text', label: 'No instruction text in source or English media seed', group: 'Content', missing: (r) => !r.has_source_instructions && !r.has_seed_english_instructions },
  { id: 'missing-both-gif-and-photos', label: 'Neither GIF nor photo', group: 'Combined gaps', missing: (r) => !r.has_demo_gif && !r.has_photo },
  { id: 'missing-all-visual-media', label: 'No GIF, photo, direct demonstration or tutorial', group: 'Combined gaps', missing: (r) => !r.has_demo_gif && !r.has_photo && !r.has_tutorial && !r.has_demo_video },
  { id: 'missing-visual-and-instructions', label: 'No GIF/photo and no instruction text in source or seed', group: 'Combined gaps', missing: (r) => !r.has_demo_gif && !r.has_photo && !r.has_source_instructions && !r.has_seed_english_instructions },
  { id: 'missing-primary-muscles', label: 'Empty primary muscles', group: 'Catalogue fields', missing: (r) => !r.has_primary_muscles },
  { id: 'missing-secondary-muscles', label: 'Empty secondary muscles (can be intentional)', group: 'Catalogue fields', missing: (r) => !r.has_secondary_muscles },
  { id: 'unreviewed-secondary-muscles', label: 'Empty supporting-muscle list without a recorded review', group: 'Catalogue fields', missing: (r) => r.secondary_review_status === 'unreviewed' },
  { id: 'missing-muscle-group', label: 'Empty muscle group', group: 'Catalogue fields', missing: (r) => !hasText(r.muscle_group) },
  { id: 'missing-equipment', label: 'Empty app equipment', group: 'Catalogue fields', missing: (r) => !hasText(r.equipment) },
  { id: 'missing-logging-type', label: 'Empty logging type', group: 'Catalogue fields', missing: (r) => !hasText(r.logging_type) },
  ...[
    ['difficulty', 'Difficulty'], ['force', 'Force (push/pull/static)'], ['mechanic', 'Mechanic (compound/isolation)'],
    ['category', 'Original category'], ['equipment', 'Original equipment'],
  ].map(([key, label]) => ({
    id: `missing-source-${key}`, label: `Missing retained source ${label.toLowerCase()}`,
    group: 'Retained source metadata (not exposed as dedicated UI fields)',
    missing: (r) => !hasText(r[`source_${key}`]),
    reason: (r) => !r.source_id ? 'No mapped source record'
      : r.source_id.startsWith('hasaneyldrm:') ? `Mapped hasaneyldrm source does not provide ${key}` : `Source ${key} is empty/null`,
  })),
];

const summary = lists.map(({ missing, reason, ...definition }) => {
  const missingRows = rows.filter(missing).map((row) => ({
    ...row, reason: reason?.(row) ?? definition.label,
  }));
  if (new Set(missingRows.map((row) => row.name)).size !== missingRows.length) throw new Error(`Duplicate rows: ${definition.id}`);
  saveCsv(`${definition.id}.csv`, ['name', 'muscle_group', 'equipment', 'source_id', 'reason'], missingRows);
  return { ...definition, missing: missingRows.length, present: rows.length - missingRows.length, file: `${definition.id}.csv` };
});
saveCsv('all-exercises.csv', Object.keys(rows[0]), rows);
saveCsv('summary.csv', ['label', 'missing', 'present', 'file'], summary);
writeFileSync(join(output, 'summary.json'), JSON.stringify({
  scope: 'Local catalogue and source/seed files only; not a live database or availability audit.',
  catalogueExercises: rows.length, retainedSourceRecords: { freeExerciseDb: snapshot.length, hasaneyldrm: hasanProvenance.records, wger: wgerProvenance.snapshots.exerciseinfo.records }, lists: summary,
}, null, 2) + '\n');

const lines = [
  '# Exercise data gaps', '',
  `Inventory: **${rows.length.toLocaleString('en')} catalogue exercises**, using ${snapshot.length} retained free-exercise-db records, ${hasanProvenance.records.toLocaleString('en')} retained hasaneyldrm records and ${wgerProvenance.snapshots.exerciseinfo.records} retained wger records.`, '',
  'These lists describe the source resolver output from local prepared data, not live user/database coverage. URL counts require valid HTTPS. The hasaneyldrm media paths were checked against the pinned repository tree; other assets and tutorial videos still require live checks. Consult the integration report for mapping decisions.', '',
  'GIF coverage includes labelled photo-pose sequences and hold references approved by the user, plus original schematic pose sequences. These are distinct from continuous motion footage and instructional tutorials. See the [dev rollout](../exercise-dev/README.md) for the type breakdown and [GIF availability results](../exercise-dev/gif-availability.json) for live asset checks.', '',
  'Approved coach instructions and curated database-only media cannot be counted from these files. Source instructions are an app fallback. English media-seed steps are separate candidate copy seeded as pending: their presence does not establish approval or that they appear to users.', '',
  'Blank secondary muscles can be intentional. The app equipment bucket `other` counts as present, even when upstream equipment is null or unsupported. Missing retained source metadata includes both unmapped catalogue exercises and null fields in mapped records; each CSV states which.', '',
  'Retained difficulty/force/mechanic/category are not dedicated UI fields yet. These lists measure the available source data for future use, not currently displayed labels.', '',
  'An exercise can appear in multiple lists. Do not add the counts together.', '',
  '[Master spreadsheet: every exercise and coverage flag](all-exercises.csv) · [Summary CSV](summary.csv) · [Summary JSON](summary.json)', '',
];
for (const group of [...new Set(summary.map((entry) => entry.group))]) {
  lines.push(`## ${group}`, '', '| Missing data | Missing | Present | Separate list |', '| --- | ---: | ---: | --- |');
  for (const item of summary.filter((entry) => entry.group === group))
    lines.push(`| ${item.label} | ${item.missing} | ${item.present} | [CSV](${item.file}) |`);
  lines.push('');
}
lines.push('## Refresh', '', 'From the backend root:', '', '```powershell', 'node services/health-service/scripts/reportExerciseDataGaps.mjs', '```', '');
writeFileSync(join(output, 'README.md'), lines.join('\n'));
console.log(JSON.stringify({ catalogueExercises: rows.length, lists: summary.map(({ label, missing }) => ({ label, missing })), output }, null, 2));
