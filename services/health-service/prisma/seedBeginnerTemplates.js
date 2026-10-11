// The coach journey's beginner gym content (B7): the four starter routines
// the customer app bundles (lib/data/workout/starter_templates.dart), ported
// to system WorkoutTemplates so the plan engine can name a real template in
// every gym slot it writes (Prescription.workoutSlots.templateId).
//
// Ported rather than linked: the client's copy exists so the app can show a
// starter week with no server at all (consent declined), and this copy exists
// so the SERVER's plan points at rows it owns. The two must stay in sync by
// review - names, exercises, sets, reps and rests below are the Dart file's
// own values, with one translation: Dart expresses the plank as
// targetReps: 30, and the backend's Plank is a duration exercise
// (loggingType 'duration'), so it is seeded as 30 SECONDS - the same shape
// seedHomeTrack.js gives its planks. A reps value on a duration exercise
// fails loudly at seed time, not silently at render time.
//
// Run AFTER seed.js (which creates the exercises this file resolves by
// name). Idempotent: re-running skips any template whose name already
// exists, same convention as seedHomeTrack.js.
//   node prisma/seed.js && node prisma/seedHomeTrack.js && node prisma/seedBeginnerTemplates.js
//
// Unlike seedHomeTrack.js, the seed function is exported and the script only
// runs when executed directly, so the idempotency test can import the
// function against a fake prisma without a database.
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';

// "Full Body x3 - Beginner-friendly" is the routine the whole journey hangs
// its first week on: the Contracts' consent-declined starter week and the
// first three gym slots of a coached beginner plan are both THIS template,
// so the day-one plan and the no-consent plan agree on what a beginner does.
const TEMPLATES = [
  {
    key: 'gym_starter_full_body_x3',
    name: 'Full Body x3 — Beginner-friendly',
    description: 'Six exercises, three days a week — the beginner-friendly full-body starter.',
    estMinutes: 45,
    level: 'beginner',
    exercises: [
      { name: 'Leg Press', sets: 3, reps: 10, restSeconds: 90 },
      { name: 'Cable Pull-Through', sets: 3, reps: 12, restSeconds: 90 },
      { name: 'Barbell Bench Press', sets: 3, reps: 8, restSeconds: 90 },
      { name: 'Seated Cable Row', sets: 3, reps: 10, restSeconds: 90 },
      { name: 'Overhead Press', sets: 3, reps: 8, restSeconds: 90 },
      { name: 'Plank', sets: 3, seconds: 30, restSeconds: 45 },
    ],
  },
  {
    key: 'gym_starter_push_a',
    name: 'Push Day A',
    description: 'Chest, shoulders and triceps — six exercises.',
    estMinutes: 45,
    level: 'beginner',
    exercises: [
      { name: 'Barbell Bench Press', sets: 3, reps: 10, restSeconds: 120 },
      { name: 'Incline Dumbbell Press', sets: 3, reps: 10, restSeconds: 90 },
      { name: 'Overhead Press', sets: 3, reps: 8, restSeconds: 120 },
      { name: 'Cable Overhead Triceps Extension', sets: 3, reps: 12, restSeconds: 60 },
      { name: 'Lateral Raise', sets: 3, reps: 12, restSeconds: 60 },
      { name: 'Triceps Pushdown', sets: 3, reps: 12, restSeconds: 60 },
    ],
  },
  {
    key: 'gym_starter_legs',
    name: 'Leg Day',
    description: 'Quads, hamstrings and glutes — five exercises.',
    estMinutes: 40,
    level: 'beginner',
    exercises: [
      { name: 'Barbell Squat', sets: 3, reps: 8, restSeconds: 150 },
      { name: 'Leg Press', sets: 3, reps: 10, restSeconds: 120 },
      { name: 'Deadlift', sets: 3, reps: 8, restSeconds: 120 },
      { name: 'Cable Pull-Through', sets: 3, reps: 12, restSeconds: 90 },
      { name: 'Calf Raise', sets: 3, reps: 15, restSeconds: 60 },
    ],
  },
  {
    key: 'gym_starter_upper_abs',
    name: 'Upper & Abs',
    description: 'Back, chest, shoulders and core — six exercises.',
    estMinutes: 45,
    level: 'beginner',
    exercises: [
      { name: 'Lat Pulldown', sets: 3, reps: 10, restSeconds: 90 },
      { name: 'Barbell Row', sets: 3, reps: 10, restSeconds: 90 },
      { name: 'Barbell Bench Press', sets: 3, reps: 8, restSeconds: 90 },
      { name: 'Face Pull', sets: 3, reps: 15, restSeconds: 60 },
      { name: 'Cable Crunch', sets: 3, reps: 12, restSeconds: 60 },
      { name: 'Plank', sets: 3, seconds: 30, restSeconds: 45 },
    ],
  },
];

// The template the slot builder reaches for first, by key, so tests and the
// pool in starterPlanService.js have one name to agree on.
export const BEGINNER_TEMPLATE_NAMES = TEMPLATES.map((t) => t.name);

async function resolveExerciseIds(prisma) {
  const names = [...new Set(TEMPLATES.flatMap((t) => t.exercises.map((e) => e.name)))];
  const rows = await prisma.exercise.findMany({ where: { name: { in: names }, createdByUserId: null } });
  const byName = new Map(rows.map((r) => [r.name, r]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(
      `seedBeginnerTemplates: missing exercises [${missing.join(', ')}] — run "node prisma/seed.js" first.`,
    );
  }
  return byName;
}

function buildExerciseRow(spec, order, byName) {
  const exercise = byName.get(spec.name);
  const isDuration = exercise.loggingType === 'duration';
  if (isDuration && spec.seconds === undefined) {
    throw new Error(`seedBeginnerTemplates: "${spec.name}" is a duration exercise but no "seconds" was given (got reps instead).`);
  }
  if (!isDuration && spec.reps === undefined) {
    throw new Error(`seedBeginnerTemplates: "${spec.name}" is a reps exercise but no "reps" was given (got seconds instead).`);
  }
  return {
    exerciseId: exercise.id,
    order,
    targetSets: spec.sets,
    targetReps: isDuration ? null : spec.reps,
    targetDurationSeconds: isDuration ? spec.seconds : null,
    restSeconds: spec.restSeconds ?? null,
  };
}

/**
 * Seed the four beginner gym starters as system templates. Idempotent: a
 * template that already exists (by name, system) is left exactly as it is,
 * so re-running after editing a routine here does NOT silently change what
 * users who already copied it are following - edit content through the
 * admin surface, not by re-running this file.
 */
export async function seedBeginnerTemplates(prisma) {
  const byName = await resolveExerciseIds(prisma);

  const idByName = new Map();
  let created = 0;
  for (const t of TEMPLATES) {
    const existing = await prisma.workoutTemplate.findFirst({ where: { name: t.name, isSystem: true } });
    if (existing) {
      idByName.set(t.key, existing.id);
      continue;
    }
    const row = await prisma.workoutTemplate.create({
      data: {
        userId: null,
        isSystem: true,
        name: t.name,
        description: t.description,
        estMinutes: t.estMinutes,
        level: t.level,
        exercises: { create: t.exercises.map((e, i) => buildExerciseRow(e, i, byName)) },
      },
    });
    idByName.set(t.key, row.id);
    created++;
  }
  return { created, total: TEMPLATES.length, idByName };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const out = await seedBeginnerTemplates(prisma);
    console.log(`Seeded ${out.created} of ${out.total} beginner gym templates (${out.created === 0 ? 'already present' : 'new'}).`);
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
