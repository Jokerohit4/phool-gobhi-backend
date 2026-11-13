// Offline, reproducible import. No database connection or uploads.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const write = (path, data) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
};
const source = read('prisma/sources/free-exercise-db.json');
const base = read('prisma/sources/catalogue-base.json');
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const equipmentMap = { 'body only': 'bodyweight', kettlebells: 'kettlebell', 'e-z curl bar': 'barbell',
  barbell: 'barbell', dumbbell: 'dumbbell', cable: 'cable', machine: 'machine' };
const muscleGroups = {
  abdominals: 'core', chest: 'chest', shoulders: 'shoulders', biceps: 'arms', triceps: 'arms', forearms: 'arms',
  hamstrings: 'legs', quadriceps: 'legs', calves: 'legs', glutes: 'legs', adductors: 'legs', abductors: 'legs',
  'middle back': 'back', 'lower back': 'back', lats: 'back', traps: 'back', neck: 'shoulders',
};
// Explicit equivalences only. Other variations remain separate exercises.
const equivalent = {
  'Barbell Bench Press - Medium Grip': 'Barbell Bench Press',
  'Barbell Deadlift': 'Deadlift', 'Pushups': 'Push-up', 'Pullups': 'Pull-up',
  'Dumbbell Bicep Curl': 'Dumbbell Curl', 'Hammer Curls': 'Hammer Curl',
  'Concentration Curls': 'Concentration Curl', 'Cross Body Hammer Curl': 'Cross-Body Hammer Curl',
  'Lying Leg Curls': 'Lying Leg Curl', 'Machine Preacher Curls': 'Machine Preacher Curl',
  'Standing Military Press': 'Overhead Press', 'Seated Barbell Military Press': 'Seated Barbell Press',
  'Front Barbell Squat': 'Front Squat', 'Zercher Squats': 'Zercher Squat',
  'Stiff-Legged Barbell Deadlift': 'Stiff-Leg Deadlift',
  'Rope Jumping': 'Jump Rope', 'Bicycling, Stationary': 'Stationary Bike',
  'Elliptical Trainer': 'Elliptical', 'Rowing, Stationary': 'Rowing Machine',
  'Walking, Treadmill': 'Treadmill Walk', 'Running, Treadmill': 'Treadmill Run',
  'Goblet Squat': 'Kettlebell Goblet Squat', 'Air Bike': 'Air Bike (Bicycle Crunch)',
  'Seated Cable Rows': 'Seated Cable Row', 'High Cable Curls': 'High Cable Curl',
  'Standing Calf Raises': 'Standing Calf Raise',
  'Split Squats': 'Split Squat Stretch', 'Squats - With Bands': 'Band Squat',
};
// Upstream leaves equipment null for these unambiguously bodyweight movements.
const bodyweight = new Set(['Decline Push-Up', 'Inverted Row', 'Scapular Pull-Up', "World's Greatest Stretch"]);
const catalogue = structuredClone(base);
const byName = new Map(catalogue.map((e) => [normalize(e.name), e]));
const sources = {};
const decisions = [];
const timedCardio = new Set(['Rope Jumping', 'Stairmaster', 'Step Mill']);
for (const entry of source) {
  const equipment = bodyweight.has(entry.name) ? 'bodyweight' : equipmentMap[entry.equipment] ?? 'other';
  let name = equivalent[entry.name] ?? entry.name;
  let existing = byName.get(normalize(name));
  if (existing && existing.equipment !== equipment) {
    name = `${name} (${entry.equipment ?? 'Other Equipment'})`;
    existing = byName.get(normalize(name));
  }
  if (existing) name = existing.name;
  if (!existing) {
    const exercise = {
      name,
      muscleGroup: entry.category === 'cardio' ? 'cardio' : muscleGroups[entry.primaryMuscles[0]] ?? 'fullBody',
      equipment,
      loggingType: entry.category === 'stretching' || entry.force === 'static' || timedCardio.has(entry.name)
        ? 'duration' : entry.category === 'cardio' ? 'duration_distance' : 'sets_reps_weight',
      primaryMuscles: entry.primaryMuscles.map((m) => m === 'abdominals' ? 'Core' : m[0].toUpperCase() + m.slice(1)),
      secondaryMuscles: entry.secondaryMuscles.map((m) => m === 'abdominals' ? 'Core' : m[0].toUpperCase() + m.slice(1)),
      aliases: name === entry.name ? [] : [entry.name],
    };
    catalogue.push(exercise);
    byName.set(normalize(name), exercise);
  } else if (name !== entry.name && !existing.aliases.includes(entry.name)) {
    existing.aliases.push(entry.name);
  }
  // One exact image sequence per canonical movement; never combine variants.
  if (!sources[name]) sources[name] = {
    sourceId: entry.id, sourceName: entry.name, equipment,
    images: entry.images, instructions: entry.instructions,
  };
  decisions.push({ source: entry.name, exercise: name, action: existing ? 'mapped' : 'added' });
}
write('prisma/exerciseCatalogue.json', catalogue);
write('prisma/exerciseSources.json', sources);
write('prisma/sources/import-report.json', {
  sourceExercises: source.length, originalExercises: base.length, totalExercises: catalogue.length,
  added: catalogue.length - base.length, mapped: decisions.filter((d) => d.action === 'mapped').length,
  imageSequences: Object.values(sources).filter((s) => s.images.length).length, decisions,
});
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const array = (values) => `ARRAY[${values.map(quote).join(', ')}]::text[]`;
const rows = catalogue.slice(base.length).map((e) => `  (${[
  quote(e.name), `${quote(e.muscleGroup)}::health."MuscleGroup"`, `${quote(e.equipment)}::health."Equipment"`,
  `${quote(e.loggingType)}::health."LoggingType"`, array(e.primaryMuscles), array(e.secondaryMuscles),
].join(', ')})`);
write('prisma/migrations/20261104120000_free_exercise_db_catalogue/migration.sql', `-- Additive import; existing global IDs, curated fields, private exercises and history remain intact.
INSERT INTO health."Exercise" ("name", "muscleGroup", "equipment", "loggingType", "primaryMuscles", "secondaryMuscles", "createdAt", "updatedAt")
SELECT c.*, NOW(), NOW() FROM (VALUES
${rows.join(',\n')}
) AS c("name", "muscleGroup", "equipment", "loggingType", "primaryMuscles", "secondaryMuscles")
WHERE NOT EXISTS (
  SELECT 1 FROM health."Exercise" e
  WHERE lower(e."name") = lower(c."name") AND e."createdByUserId" IS NULL
);
`);
console.log(`Catalogue: ${base.length} -> ${catalogue.length}; ${catalogue.length - base.length} added; ${source.length} source records mapped.`);
