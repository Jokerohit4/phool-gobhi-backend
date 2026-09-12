// The home track's starter content (docs/../sprint2/PG-HUNT-001 §13):
// 12 no-equipment system routines + the 4-week beginner plan built from
// them. Content entry against infrastructure that already shipped (the
// exercise library, WorkoutTemplate, TemplateExercise) — not a new build.
//
// Run AFTER seed.js (which must have already created the bodyweight
// exercises this file looks up by name). Idempotent: re-running skips any
// template/plan whose key already exists, same convention as seed.js.
//   node prisma/seed.js && node prisma/seedHomeTrack.js
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// exerciseId is resolved by name at seed time (see resolveExerciseIds
// below) rather than hardcoded, so this file doesn't care what order
// seed.js's array assigns ids in.
//
// sets: An exercise's target, as { sets, reps } or { sets, seconds } —
// never both; matches the loggingType each exercise was seeded with
// (sets_reps_weight vs duration). Getting this wrong for a given exercise
// fails loudly at seed time (see buildExerciseRow), not silently at
// template-render time.
const TEMPLATES = [
  {
    key: 'home_full_body_20',
    name: 'Full body — no equipment',
    description: 'Squat, incline push-up, glute bridge, plank, dead bug — one round.',
    estMinutes: 20,
    level: 'beginner',
    exercises: [
      { name: 'Bodyweight Squat', sets: 3, reps: 12 },
      { name: 'Incline Push-up', sets: 3, reps: 10 },
      { name: 'Glute Bridge', sets: 3, reps: 15 },
      { name: 'Plank', sets: 3, seconds: 30 },
      { name: 'Dead Bug', sets: 3, reps: 10 },
    ],
  },
  {
    key: 'home_full_body_15',
    name: 'Full body — 15 minute',
    description: 'The 20-minute full-body routine, two rounds, shorter rest.',
    estMinutes: 15,
    level: 'beginner',
    exercises: [
      { name: 'Bodyweight Squat', sets: 2, reps: 12 },
      { name: 'Incline Push-up', sets: 2, reps: 10 },
      { name: 'Glute Bridge', sets: 2, reps: 15 },
      { name: 'Plank', sets: 2, seconds: 30 },
      { name: 'Dead Bug', sets: 2, reps: 10 },
    ],
  },
  {
    key: 'home_push',
    name: 'Push — bodyweight',
    description: 'Incline push-up, pike push-up, chair dip.',
    estMinutes: 22,
    level: 'beginner',
    exercises: [
      { name: 'Incline Push-up', sets: 3, reps: 10 },
      { name: 'Pike Push-up', sets: 3, reps: 8 },
      { name: 'Chair Dip', sets: 3, reps: 10 },
    ],
  },
  {
    key: 'home_pull',
    name: 'Pull — no bar',
    description: 'Towel row, superman — everything a pull-up bar would otherwise cover.',
    estMinutes: 20,
    level: 'beginner',
    exercises: [
      { name: 'Towel Row', sets: 3, reps: 12 },
      { name: 'Superman', sets: 3, reps: 12 },
    ],
  },
  {
    key: 'home_legs',
    name: 'Legs — bodyweight',
    description: 'Squat, split squat, calf raise, wall sit.',
    estMinutes: 24,
    level: 'beginner',
    exercises: [
      { name: 'Bodyweight Squat', sets: 3, reps: 15 },
      { name: 'Split Squat', sets: 3, reps: 10 },
      { name: 'Calf Raise', sets: 3, reps: 15 },
      { name: 'Wall Sit', sets: 3, seconds: 30 },
    ],
  },
  {
    key: 'home_core_10',
    name: 'Core — 10 minute',
    description: 'Plank, side plank, dead bug, hollow hold.',
    estMinutes: 10,
    level: 'beginner',
    exercises: [
      { name: 'Plank', sets: 2, seconds: 30 },
      { name: 'Side Plank', sets: 2, seconds: 20 },
      { name: 'Dead Bug', sets: 2, reps: 10 },
      { name: 'Hollow Hold', sets: 2, seconds: 20 },
    ],
  },
  {
    key: 'home_cardio_low_impact',
    name: 'Low-impact cardio (no jumping)',
    description: 'March in place, step-back lunge, shadow boxing.',
    estMinutes: 20,
    level: 'beginner',
    exercises: [
      { name: 'March in Place', sets: 3, seconds: 60 },
      { name: 'Step-Back Lunge', sets: 3, reps: 12 },
      { name: 'Shadow Boxing', sets: 3, seconds: 60 },
    ],
  },
  {
    key: 'home_mobility',
    name: 'Mobility & stretch',
    description: 'A gentle full-body flow. No target pace — move at whatever speed feels right.',
    estMinutes: 15,
    level: 'beginner',
    exercises: [{ name: 'Yoga Flow', sets: 1, seconds: 900 }],
  },
  {
    key: 'home_push_intermediate',
    name: 'Push — intermediate',
    description: 'The push routine, more sets and higher reps.',
    estMinutes: 25,
    level: 'intermediate',
    exercises: [
      { name: 'Incline Push-up', sets: 4, reps: 14 },
      { name: 'Pike Push-up', sets: 4, reps: 10 },
      { name: 'Chair Dip', sets: 4, reps: 14 },
    ],
  },
  {
    key: 'home_legs_intermediate',
    name: 'Legs — intermediate',
    description: 'The legs routine, more sets and a longer wall sit.',
    estMinutes: 26,
    level: 'intermediate',
    exercises: [
      { name: 'Bodyweight Squat', sets: 4, reps: 18 },
      { name: 'Split Squat', sets: 4, reps: 12 },
      { name: 'Calf Raise', sets: 4, reps: 18 },
      { name: 'Wall Sit', sets: 3, seconds: 45 },
    ],
  },
  {
    key: 'home_full_body_intermediate',
    name: 'Full body — intermediate',
    description: 'The full-body circuit, four rounds.',
    estMinutes: 30,
    level: 'intermediate',
    exercises: [
      { name: 'Bodyweight Squat', sets: 4, reps: 15 },
      { name: 'Incline Push-up', sets: 4, reps: 12 },
      { name: 'Glute Bridge', sets: 4, reps: 18 },
      { name: 'Plank', sets: 4, seconds: 40 },
      { name: 'Dead Bug', sets: 4, reps: 12 },
    ],
  },
  {
    key: 'home_desk_reset',
    name: 'Desk reset — 8 minute',
    description: 'A short mobility break. Neck, shoulders and hips — built for a workday, not a workout.',
    estMinutes: 8,
    level: 'beginner',
    exercises: [{ name: 'Yoga Flow', sets: 1, seconds: 480 }],
  },
];

// The 75-coin marketplace reward (H-22). Week 4 ends on Full body —
// intermediate so it lands on something to push against — the already-built
// PR celebration has something to fire on even for a user who has never
// seen a gym.
const PLAN = {
  key: 'home_starter_4w',
  name: '4-week home starter',
  description: 'No equipment. Three or four short sessions a week, building up gradually.',
  weeks: 4,
  // weekIndex/dayIndex -> template key, or null for a rest day. Every week
  // gets exactly 7 entries so getActivePlanService never has to guess
  // whether a missing day means rest or an unfinished seed.
  schedule: [
    // Week 1 — learn the movements, short on purpose.
    ['home_full_body_15', null, 'home_core_10', null, 'home_mobility', null, null],
    // Week 2 — full length, same difficulty.
    ['home_full_body_20', null, 'home_core_10', null, 'home_cardio_low_impact', null, null],
    // Week 3 — split introduced.
    ['home_push', 'home_pull', null, 'home_legs', null, 'home_mobility', null],
    // Week 4 — a harder push, ending on the intermediate full-body circuit.
    ['home_push_intermediate', 'home_pull', null, 'home_legs_intermediate', null, 'home_full_body_intermediate', null],
  ],
};

async function resolveExerciseIds() {
  const names = [...new Set(TEMPLATES.flatMap((t) => t.exercises.map((e) => e.name)))];
  const rows = await prisma.exercise.findMany({ where: { name: { in: names }, createdByUserId: null } });
  const byName = new Map(rows.map((r) => [r.name, r]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(
      `seedHomeTrack: missing exercises [${missing.join(', ')}] — run "node prisma/seed.js" first.`
    );
  }
  return byName;
}

function buildExerciseRow(spec, order, byName) {
  const exercise = byName.get(spec.name);
  const isDuration = exercise.loggingType === 'duration';
  if (isDuration && spec.seconds === undefined) {
    throw new Error(`seedHomeTrack: "${spec.name}" is a duration exercise but no "seconds" was given (got reps instead).`);
  }
  if (!isDuration && spec.reps === undefined) {
    throw new Error(`seedHomeTrack: "${spec.name}" is a reps exercise but no "reps" was given (got seconds instead).`);
  }
  return {
    exerciseId: exercise.id,
    order,
    targetSets: spec.sets,
    targetReps: isDuration ? null : spec.reps,
    targetDurationSeconds: isDuration ? spec.seconds : null,
  };
}

async function seedTemplates(byName) {
  const templateIdByKey = new Map();
  for (const t of TEMPLATES) {
    const existing = await prisma.workoutTemplate.findFirst({ where: { name: t.name, isSystem: true } });
    if (existing) {
      templateIdByKey.set(t.key, existing.id);
      continue;
    }
    const created = await prisma.workoutTemplate.create({
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
    templateIdByKey.set(t.key, created.id);
  }
  return templateIdByKey;
}

async function seedPlan(templateIdByKey) {
  let plan = await prisma.workoutPlan.findUnique({ where: { key: PLAN.key } });
  if (!plan) {
    plan = await prisma.workoutPlan.create({
      data: { key: PLAN.key, name: PLAN.name, description: PLAN.description, weeks: PLAN.weeks, isSystem: true },
    });
  }

  const existingDays = await prisma.workoutPlanDay.count({ where: { planId: plan.id } });
  if (existingDays > 0) return; // already seeded

  const rows = [];
  PLAN.schedule.forEach((week, weekIdx) => {
    week.forEach((templateKey, dayIdx) => {
      rows.push({
        planId: plan.id,
        weekIndex: weekIdx + 1,
        dayIndex: dayIdx + 1,
        templateId: templateKey ? templateIdByKey.get(templateKey) : null,
      });
    });
  });
  await prisma.workoutPlanDay.createMany({ data: rows });
}

async function main() {
  const byName = await resolveExerciseIds();
  const templateIdByKey = await seedTemplates(byName);
  await seedPlan(templateIdByKey);
  console.log(`Seeded ${TEMPLATES.length} system routines and the ${PLAN.name} plan.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
